/**
 * TTL + LRU cache and in-flight request coalescing.
 *
 * Search results and fetched pages are expensive and often requested twice
 * (the model retries, or two tool calls in one batch ask the same thing).
 * This layer keeps a bounded, expiring cache and merges concurrent misses for
 * the same key into one upstream request.
 */

import { WebToolError } from "./errors.ts";

export interface CacheStats {
	hits: number;
	misses: number;
	coalesced: number;
	aborts: number;
	stores: number;
	failures: number;
}

export function createCacheStats(): CacheStats {
	return { hits: 0, misses: 0, coalesced: 0, aborts: 0, stores: 0, failures: 0 };
}

export interface TtlLruOptions {
	ttlMs: number;
	maxEntries: number;
	now?: () => number;
}

interface Entry<V> {
	value: V;
	expiresAt: number;
}

export class TtlLruCache<K, V> {
	private readonly entries = new Map<K, Entry<V>>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(options: TtlLruOptions) {
		this.ttlMs = Math.max(0, options.ttlMs);
		this.maxEntries = Math.max(0, options.maxEntries);
		this.now = options.now ?? Date.now;
	}

	get disabled(): boolean {
		return this.ttlMs <= 0 || this.maxEntries <= 0;
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: K): V | undefined {
		if (this.disabled) return undefined;
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		// Refresh recency: Map iteration order is insertion order.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	set(key: K, value: V): void {
		if (this.disabled) return;
		this.entries.delete(key);
		this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.entries.delete(oldest.value);
		}
	}
}

export type CacheSource = "cache" | "coalesced" | "network";

export interface CachedValue<V> {
	value: V;
	source: CacheSource;
}

interface Inflight<V> {
	promise: Promise<V>;
	controller: AbortController;
	waiters: number;
	settled: boolean;
}

function abortError(): WebToolError {
	return new WebToolError("aborted", "request was cancelled", {
		cause: new DOMException("aborted", "AbortError"),
	});
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void promise.catch(() => {});
		return Promise.reject(abortError());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(abortError());
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

/**
 * Cache plus single-flight. Failures are never cached. When the last waiter
 * aborts, the shared upstream request is aborted too.
 */
export class SharedFetchCache<K, V> {
	readonly stats: CacheStats = createCacheStats();
	private readonly inflight = new Map<K, Inflight<V>>();
	private readonly cache: TtlLruCache<K, V>;

	constructor(cache: TtlLruCache<K, V>) {
		this.cache = cache;
	}

	get size(): number {
		return this.cache.size;
	}

	async getOrLoad(
		key: K,
		loader: (signal: AbortSignal) => Promise<V>,
		callerSignal?: AbortSignal,
	): Promise<CachedValue<V>> {
		if (callerSignal?.aborted) throw abortError();

		const cached = this.cache.get(key);
		if (cached !== undefined) {
			this.stats.hits += 1;
			return { value: cached, source: "cache" };
		}
		this.stats.misses += 1;

		let entry = this.inflight.get(key);
		const joined = entry !== undefined;
		if (entry) {
			this.stats.coalesced += 1;
			entry.waiters += 1;
		} else {
			const controller = new AbortController();
			const record: Inflight<V> = {
				controller,
				waiters: 1,
				settled: false,
				promise: Promise.resolve() as unknown as Promise<V>,
			};
			record.promise = (async () => loader(controller.signal))()
				.then(
					(value) => {
						record.settled = true;
						// A cancelled loader may finish after a retry. Only the current,
						// live request may publish into the shared cache.
						if (!controller.signal.aborted && this.inflight.get(key) === record) {
							this.stats.stores += 1;
							this.cache.set(key, value);
						}
						return value;
					},
					(error: unknown) => {
						record.settled = true;
						this.stats.failures += 1;
						throw error;
					},
				)
				.finally(() => {
					if (this.inflight.get(key) === record) this.inflight.delete(key);
				});
			// A loader that loses all waiters can reject after everyone stopped
			// listening; keep that from surfacing as an unhandled rejection.
			void record.promise.catch(() => {});
			this.inflight.set(key, record);
			entry = record;
		}

		const current = entry;
		try {
			const value = callerSignal ? await raceAbort(current.promise, callerSignal) : await current.promise;
			return { value, source: joined ? "coalesced" : "network" };
		} finally {
			current.waiters -= 1;
			if (current.waiters <= 0 && !current.settled) {
				current.settled = true;
				this.stats.aborts += 1;
				// Remove the doomed request before aborting it. A caller that retries
				// in this window must start fresh work, not join a request that is
				// already being cancelled.
				if (this.inflight.get(key) === current) this.inflight.delete(key);
				current.controller.abort(new DOMException("no waiters", "AbortError"));
			}
		}
	}
}
