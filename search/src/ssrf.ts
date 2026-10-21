/**
 * SSRF guard for `web_fetch`.
 *
 * The model can be induced to fetch arbitrary URLs, so the guard rejects
 * anything that is not a plain public HTTP(S) URL: credentials in the URL,
 * loopback/private/link-local/reserved destinations, cloud metadata hosts,
 * and DNS names that resolve into those ranges.
 *
 * Residual risk: DNS is checked before the request, so a hostile resolver can
 * still rebind between the check and the fetch. Keeping this in the same
 * process as `fetch` (rather than a preflight in another service) keeps the
 * window small; `allowPrivateHosts` exists only for controlled environments.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { WebToolError } from "./errors.ts";

export const MAX_URL_LENGTH = 8192;

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
	"instance-data",
	"instance-data.ec2.internal",
]);

export type LookupFn = (hostname: string) => Promise<readonly string[]>;

export interface UrlGuardOptions {
	allowPrivateHosts?: boolean;
	/** Injectable DNS lookup for tests. Defaults to `dns.promises.lookup`. */
	lookup?: LookupFn;
	/** Caller cancellation for the DNS lookup. */
	signal?: AbortSignal;
	/** Bound the DNS lookup; the HTTP attempt timeout otherwise starts after it. */
	timeoutMs?: number;
}

const defaultLookup: LookupFn = async (hostname) => {
	const records = await lookup(hostname, { all: true, verbatim: true });
	return records.map((record) => record.address);
};

/**
 * Resolve with the caller's deadline and cancellation. `dns.promises.lookup`
 * has no abort parameter, so the lookup itself may linger; the caller is
 * bounded and the late result is ignored.
 */
async function lookupWithBounds(
	lookupFn: LookupFn,
	hostname: string,
	options: UrlGuardOptions,
): Promise<readonly string[]> {
	if (!options.signal && options.timeoutMs === undefined) return lookupFn(hostname);
	if (options.signal?.aborted) {
		throw new WebToolError("aborted", "request was cancelled", {
			cause: new DOMException("aborted", "AbortError"),
		});
	}

	return new Promise<readonly string[]>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			settle();
		};

		onAbort = () =>
			finish(() =>
				reject(
					new WebToolError("aborted", "request was cancelled", {
						cause: new DOMException("aborted", "AbortError"),
					}),
				),
			);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs !== undefined) {
			timer = setTimeout(
				() =>
					finish(() =>
						reject(
							new WebToolError(
								"timeout",
								`DNS resolution for "${hostname}" timed out after ${options.timeoutMs} ms`,
								{ retryable: true },
							),
						),
					),
				options.timeoutMs,
			);
			// Keep the timer ref'd: the DNS lookup itself does not keep the event
			// loop alive, so an unref'd timer can let the process exit before the
			// timeout settles the promise.
		}
		lookupFn(hostname).then(
			(addresses) => finish(() => resolve(addresses)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

/** Validate URL syntax and scheme without touching the network. */
export function parseHttpUrl(raw: string): URL {
	if (typeof raw !== "string") {
		throw new WebToolError("invalid_input", "url must be a string");
	}
	const value = raw.trim();
	if (!value) {
		throw new WebToolError("invalid_input", "url must not be empty");
	}
	if (value.length > MAX_URL_LENGTH) {
		throw new WebToolError("invalid_input", `url must be at most ${MAX_URL_LENGTH} characters`);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new WebToolError("invalid_input", `not a valid absolute URL: ${truncateForMessage(value)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebToolError("blocked_url", `only http and https URLs are allowed, got "${url.protocol}"`);
	}
	if (url.username || url.password) {
		throw new WebToolError("blocked_url", "URLs with embedded credentials are not allowed");
	}
	if (!url.hostname) {
		throw new WebToolError("invalid_input", "URL is missing a hostname");
	}
	url.hash = "";
	return url;
}

/**
 * Reject non-public destinations. Resolves DNS unless `allowPrivateHosts` is
 * set, so tests must inject `lookup` to stay offline.
 */
export async function assertPublicUrl(raw: string, options: UrlGuardOptions = {}): Promise<URL> {
	const url = parseHttpUrl(raw);
	if (options.allowPrivateHosts) return url;

	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

	if (isBlockedHostname(hostname)) {
		throw new WebToolError("blocked_url", `refusing to fetch internal host "${hostname}"`);
	}

	// Obsolete IPv4 spellings (`2130706433`, `0x7f.1`, `0177.0.0.1`) bypass a
	// naive `isIP` check but resolve to a real address in most stacks.
	const obsoleteIpv4 = parseObsoleteIpv4(hostname);
	if (obsoleteIpv4) {
		if (isPrivateIp(obsoleteIpv4)) {
			throw new WebToolError("blocked_url", `refusing to fetch private address ${obsoleteIpv4}`);
		}
		return url;
	}

	if (isIP(hostname)) {
		if (isPrivateIp(hostname)) {
			throw new WebToolError("blocked_url", `refusing to fetch private address ${hostname}`);
		}
		return url;
	}

	const lookupFn = options.lookup ?? defaultLookup;
	let addresses: readonly string[];
	try {
		addresses = await lookupWithBounds(lookupFn, hostname, options);
	} catch (error) {
		if (error instanceof WebToolError) throw error;
		throw new WebToolError("blocked_url", `could not resolve host "${hostname}"`, { cause: error });
	}
	if (addresses.length === 0) {
		throw new WebToolError("blocked_url", `host "${hostname}" did not resolve to any address`);
	}
	for (const address of addresses) {
		if (isPrivateIp(address)) {
			throw new WebToolError("blocked_url", `host "${hostname}" resolves to private address ${address}`);
		}
	}
	return url;
}

export function isBlockedHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (BLOCKED_HOSTNAMES.has(host)) return true;
	return (
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host.endsWith(".home.arpa")
	);
}

/** Parse bare-integer, hex, octal and short IPv4 notations. */
export function parseObsoleteIpv4(hostname: string): string | undefined {
	if (!/^[0-9a-fx.]+$/i.test(hostname)) return undefined;
	if (!/\d/.test(hostname)) return undefined;

	const parts = hostname.split(".");
	if (parts.length > 4) return undefined;

	const numbers: number[] = [];
	for (const part of parts) {
		if (part === "") return undefined;
		let value: number;
		if (/^0x[0-9a-f]+$/i.test(part)) value = Number.parseInt(part.slice(2), 16);
		else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part, 8);
		else if (/^\d+$/.test(part)) value = Number(part);
		else return undefined;
		if (!Number.isSafeInteger(value) || value < 0) return undefined;
		numbers.push(value);
	}

	const [first, second = 0, third = 0, fourth] = numbers;
	if (numbers.length === 1) {
		if (first! > 0xffffffff) return undefined;
		return [first! >>> 24, (first! >>> 16) & 0xff, (first! >>> 8) & 0xff, first! & 0xff].join(".");
	}
	if (numbers.length === 2) {
		if (first! > 0xff || second > 0xffffff) return undefined;
		return [first!, (second >>> 16) & 0xff, (second >>> 8) & 0xff, second & 0xff].join(".");
	}
	if (numbers.length === 3) {
		if (first! > 0xff || second > 0xff || third > 0xffff) return undefined;
		return [first!, second, (third >>> 8) & 0xff, third & 0xff].join(".");
	}
	if (first! > 0xff || second > 0xff || third > 0xff || fourth! > 0xff) return undefined;
	return [first!, second, third, fourth!].join(".");
}

const PRIVATE_IPV4: ReadonlyArray<readonly [string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

function ipv4ToInt(ip: string): number | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		value = value * 256 + octet;
	}
	return value;
}

function isPrivateIpv4(ip: string): boolean {
	const value = ipv4ToInt(ip);
	if (value === undefined) return false;
	if (value === 0xffffffff) return true;
	for (const [base, bits] of PRIVATE_IPV4) {
		const baseValue = ipv4ToInt(base)!;
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
	}
	return false;
}

/** Parse an IPv6 address into 8 16-bit groups, or `undefined`. */
function expandIpv6(ip: string): number[] | undefined {
	let value = ip.toLowerCase();
	const zone = value.indexOf("%");
	if (zone !== -1) value = value.slice(0, zone);

	// IPv4-mapped / embedded forms.
	let embedded: string | undefined;
	const lastColon = value.lastIndexOf(":");
	if (lastColon !== -1 && value.slice(lastColon + 1).includes(".")) {
		embedded = value.slice(lastColon + 1);
		value = `${value.slice(0, lastColon + 1)}0:0`;
	}
	const embeddedV4 = embedded ? ipv4ToInt(embedded) : undefined;
	if (embedded && embeddedV4 === undefined) return undefined;

	const halves = value.split("::");
	if (halves.length > 2) return undefined;

	const parseGroups = (part: string): number[] | undefined => {
		if (!part) return [];
		const groups = part.split(":");
		const parsed: number[] = [];
		for (const group of groups) {
			if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
			parsed.push(Number.parseInt(group, 16));
		}
		return parsed;
	};

	const head = parseGroups(halves[0] ?? "");
	const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
	if (!head || !tail) return undefined;

	const total = head.length + tail.length;
	if (halves.length === 2) {
		if (total > 8) return undefined;
		const groups = [...head, ...new Array<number>(8 - total).fill(0), ...tail];
		if (embeddedV4 !== undefined) {
			groups[6] = (embeddedV4 >>> 16) & 0xffff;
			groups[7] = embeddedV4 & 0xffff;
		}
		return groups;
	}

	if (total !== 8) return undefined;
	if (embeddedV4 !== undefined) {
		head[6] = (embeddedV4 >>> 16) & 0xffff;
		head[7] = embeddedV4 & 0xffff;
	}
	return head;
}

export function isPrivateIp(ip: string): boolean {
	const version = isIP(ip);
	if (version === 4) return isPrivateIpv4(ip);
	if (version !== 6) return false;

	const groups = expandIpv6(ip);
	if (!groups) return false;

	const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
	const allZero = groups.every((group) => group === 0);
	if (allZero) return true; // ::
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
		return true; // ::1
	}
	if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
	if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
	if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard

	// IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d),
	// NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address.
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
		return isPrivateIpv4(`${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`);
	}
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		return isPrivateIpv4(`${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`);
	}
	if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		return isPrivateIpv4(`${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`);
	}
	if (g0 === 0x2002) {
		return isPrivateIpv4(`${g1 >>> 8}.${g1 & 0xff}.${g2 >>> 8}.${g2 & 0xff}`);
	}
	return false;
}

function truncateForMessage(value: string, max = 80): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}
