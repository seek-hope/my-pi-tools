import assert from "node:assert/strict";
import test from "node:test";

import { SharedFetchCache, TtlLruCache } from "../src/cache.ts";
import { WebToolError } from "../src/errors.ts";

test("TtlLruCache expires entries and refreshes recency", () => {
	let now = 1_000;
	const cache = new TtlLruCache<string, string>({ ttlMs: 100, maxEntries: 2, now: () => now });
	cache.set("a", "1");
	cache.set("b", "2");
	assert.equal(cache.get("a"), "1");
	// "a" is now most recent; inserting "c" evicts "b".
	cache.set("c", "3");
	assert.equal(cache.get("b"), undefined);
	assert.equal(cache.get("a"), "1");
	assert.equal(cache.get("c"), "3");

	now += 101;
	assert.equal(cache.get("a"), undefined);
	assert.equal(cache.get("c"), undefined);
});

test("TtlLruCache is disabled with a zero TTL or capacity", () => {
	const noTtl = new TtlLruCache<string, string>({ ttlMs: 0, maxEntries: 10 });
	noTtl.set("a", "1");
	assert.equal(noTtl.get("a"), undefined);
	assert.equal(noTtl.disabled, true);

	const noCapacity = new TtlLruCache<string, string>({ ttlMs: 1_000, maxEntries: 0 });
	noCapacity.set("a", "1");
	assert.equal(noCapacity.get("a"), undefined);
});

test("SharedFetchCache coalesces concurrent misses into one load", async () => {
	const cache = new SharedFetchCache<string, string>(
		new TtlLruCache<string, string>({ ttlMs: 1_000, maxEntries: 10 }),
	);
	let loads = 0;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const loader = async (): Promise<string> => {
		loads += 1;
		await gate;
		return "value";
	};

	const first = cache.getOrLoad("key", loader);
	const second = cache.getOrLoad("key", loader);
	release();
	const [a, b] = await Promise.all([first, second]);

	assert.equal(loads, 1);
	assert.equal(a.value, "value");
	assert.equal(b.value, "value");
	assert.deepEqual(new Set([a.source, b.source]), new Set(["network", "coalesced"]));
	assert.equal(cache.stats.coalesced, 1);

	const third = await cache.getOrLoad("key", loader);
	assert.equal(third.source, "cache");
	assert.equal(loads, 1);
	assert.equal(cache.stats.hits, 1);
});

test("SharedFetchCache does not cache failures", async () => {
	const cache = new SharedFetchCache<string, string>(
		new TtlLruCache<string, string>({ ttlMs: 1_000, maxEntries: 10 }),
	);
	let loads = 0;
	const failing = async (): Promise<string> => {
		loads += 1;
		throw new WebToolError("network", "boom", { retryable: true });
	};
	await assert.rejects(cache.getOrLoad("key", failing), /boom/);
	await assert.rejects(cache.getOrLoad("key", failing), /boom/);
	assert.equal(loads, 2);
	assert.equal(cache.stats.failures, 2);
});

test("SharedFetchCache aborts shared work when the last waiter leaves", async () => {
	const cache = new SharedFetchCache<string, string>(
		new TtlLruCache<string, string>({ ttlMs: 1_000, maxEntries: 10 }),
	);
	const controller = new AbortController();
	let loaderAborted = false;
	const loader = (signal: AbortSignal): Promise<string> =>
		new Promise((_resolve, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					loaderAborted = true;
					reject(new Error("loader aborted"));
				},
				{ once: true },
			);
		});

	const pending = cache.getOrLoad("key", loader, controller.signal);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof WebToolError);
		assert.equal(error.kind, "aborted");
		return true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(loaderAborted, true);
	assert.equal(cache.stats.aborts, 1);
});

test("SharedFetchCache starts fresh work when a retry follows the last waiter's abort", async () => {
	const cache = new SharedFetchCache<string, string>(
		new TtlLruCache<string, string>({ ttlMs: 1_000, maxEntries: 10 }),
	);
	const controller = new AbortController();
	let rejectOld: (error: Error) => void = () => {};
	const oldLoader = () =>
		new Promise<string>((_resolve, reject) => {
			rejectOld = reject;
		});

	const pending = cache.getOrLoad("key", oldLoader, controller.signal);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof WebToolError);
		assert.equal(error.kind, "aborted");
		return true;
	});

	let freshLoads = 0;
	const retry = cache.getOrLoad("key", async () => {
		freshLoads += 1;
		return "fresh";
	});
	// The old loader rejects only after the retry began; it must not affect it.
	rejectOld(new Error("original request aborted"));
	const result = await retry;
	assert.equal(freshLoads, 1);
	assert.equal(result.value, "fresh");
	assert.equal(result.source, "network");
});
