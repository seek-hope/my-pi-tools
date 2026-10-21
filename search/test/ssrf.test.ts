import assert from "node:assert/strict";
import test from "node:test";

import {
	assertPublicUrl,
	isPrivateIp,
	parseHttpUrl,
	parseObsoleteIpv4,
} from "../src/ssrf.ts";
import { WebToolError } from "../src/errors.ts";

test("parseHttpUrl accepts http and https and strips fragments", () => {
	const url = parseHttpUrl("  https://example.com/a?b=1#frag  ");
	assert.equal(url.protocol, "https:");
	assert.equal(url.hash, "");
	assert.equal(url.toString(), "https://example.com/a?b=1");
});

test("parseHttpUrl rejects non-web schemes, credentials and oversized URLs", () => {
	for (const value of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)"]) {
		assert.throws(() => parseHttpUrl(value), (error: unknown) => {
			assert.ok(error instanceof WebToolError);
			assert.equal(error.kind, "blocked_url");
			return true;
		});
	}
	assert.throws(() => parseHttpUrl("https://user:pass@example.com/"), /embedded credentials/);
	assert.throws(() => parseHttpUrl(""), /must not be empty/);
	assert.throws(() => parseHttpUrl("not a url"), /not a valid absolute URL/);
	assert.throws(() => parseHttpUrl(`https://example.com/${"a".repeat(8200)}`), /at most 8192/);
});

test("isPrivateIp covers IPv4 private, loopback, link-local, CGNAT and reserved ranges", () => {
	const privateAddresses = [
		"0.0.0.0",
		"10.1.2.3",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.0.2.1",
		"192.168.1.1",
		"198.18.0.1",
		"198.51.100.7",
		"203.0.113.9",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
	];
	for (const address of privateAddresses) {
		assert.equal(isPrivateIp(address), true, address);
	}
	for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "192.169.0.1"]) {
		assert.equal(isPrivateIp(address), false, address);
	}
});

test("isPrivateIp covers IPv6 loopback, ULA, link-local, mapped and NAT64 forms", () => {
	const privateAddresses = [
		"::",
		"::1",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"fe80::1%eth0",
		"ff02::1",
		"2001:db8::1",
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.1",
		"64:ff9b::10.0.0.1",
		"2002:7f00:1::",
	];
	for (const address of privateAddresses) {
		assert.equal(isPrivateIp(address), true, address);
	}
	for (const address of ["2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"]) {
		assert.equal(isPrivateIp(address), false, address);
	}
});

test("parseObsoleteIpv4 normalizes integer, hex and octal spellings", () => {
	assert.equal(parseObsoleteIpv4("2130706433"), "127.0.0.1");
	assert.equal(parseObsoleteIpv4("0x7f.1"), "127.0.0.1");
	assert.equal(parseObsoleteIpv4("0177.0.0.1"), "127.0.0.1");
	assert.equal(parseObsoleteIpv4("127.1"), "127.0.0.1");
	assert.equal(parseObsoleteIpv4("example.com"), undefined);
	assert.equal(parseObsoleteIpv4("1.2.3.4.5"), undefined);
	assert.equal(parseObsoleteIpv4("256.1.1.1"), undefined);
});

test("assertPublicUrl blocks loopback, metadata hosts and DNS answers in private ranges", async () => {
	await assert.rejects(assertPublicUrl("http://127.0.0.1/"), /private address/);
	await assert.rejects(assertPublicUrl("http://[::1]/"), /private address/);
	await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data"), /private address/);
	await assert.rejects(assertPublicUrl("http://metadata.google.internal/"), /internal host/);
	await assert.rejects(assertPublicUrl("http://localhost:8080/"), /internal host/);
	await assert.rejects(assertPublicUrl("http://2130706433/"), /private address/);

	await assert.rejects(
		assertPublicUrl("https://evil.example/", { lookup: async () => ["127.0.0.1"] }),
		/host "evil.example" resolves to private address 127.0.0.1/,
	);
	await assert.rejects(
		assertPublicUrl("https://mix.example/", { lookup: async () => ["93.184.216.34", "10.0.0.1"] }),
		/resolves to private address 10.0.0.1/,
	);
	await assert.rejects(
		assertPublicUrl("https://missing.example/", {
			lookup: async () => {
				throw new Error("ENOTFOUND");
			},
		}),
		/could not resolve host/,
	);
});

test("assertPublicUrl allows public hosts and honors allowPrivateHosts", async () => {
	const url = await assertPublicUrl("https://example.com/page", {
		lookup: async () => ["93.184.216.34"],
	});
	assert.equal(url.hostname, "example.com");

	const bypass = await assertPublicUrl("http://127.0.0.1:1234/", {
		allowPrivateHosts: true,
		lookup: async () => {
			throw new Error("lookup should not run");
		},
	});
	assert.equal(bypass.hostname, "127.0.0.1");
});

test("assertPublicUrl bounds DNS lookups by timeout and caller cancellation", async () => {
	const started = Date.now();
	await assert.rejects(
		assertPublicUrl("https://slow.example/", {
			lookup: () => new Promise(() => {}),
			timeoutMs: 25,
		}),
		(error: unknown) => {
			assert.ok(error instanceof WebToolError);
			assert.equal(error.kind, "timeout");
			return true;
		},
	);
	assert.ok(Date.now() - started < 1_000, "DNS timeout must not wait for the lookup");

	const controller = new AbortController();
	const pending = assertPublicUrl("https://slow.example/", {
		lookup: () => new Promise(() => {}),
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof WebToolError);
		assert.equal(error.kind, "aborted");
		return true;
	});
});
