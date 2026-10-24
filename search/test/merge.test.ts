import assert from "node:assert/strict";
import test from "node:test";

import type { SearchOutcome, SearchResultItem } from "../src/deepseek.ts";
import { canonicalResultUrl, mergeSearchOutcomes } from "../src/merge.ts";

function item(overrides: Partial<SearchResultItem>): SearchResultItem {
	return {
		title: "Untitled",
		url: "https://example.com/",
		snippet: "",
		summary: "",
		content: "",
		site_name: null,
		date: null,
		authority: -1,
		rerank_score: 0,
		...overrides,
	};
}

function outcome(provider: "deepseek" | "exa", results: SearchResultItem[]): SearchOutcome {
	return {
		results,
		fromCache: false,
		source: "network",
		durationMs: 5,
		providers: [provider],
	};
}

test("mergeSearchOutcomes deduplicates by canonical URL and records both providers", () => {
	const deepseek = outcome("deepseek", [
		item({ title: "A", url: "https://a.example/", snippet: "deepseek A" }),
		item({ title: "B", url: "https://b.example/" }),
	]);
	const exa = outcome("exa", [
		item({ title: "A from Exa", url: "https://a.example", content: "Exa body" }),
		item({ title: "C", url: "https://c.example/" }),
	]);

	const merged = mergeSearchOutcomes([deepseek, exa], 10);
	assert.equal(merged.results.length, 3);
	assert.deepEqual(merged.providers, ["deepseek", "exa"]);

	const a = merged.results.find((result) => result.url.startsWith("https://a.example"))!;
	assert.deepEqual(a.providers, ["deepseek", "exa"]);
	assert.equal(a.snippet, "deepseek A");
	assert.equal(a.content, "Exa body");
	assert.equal(merged.results[0], a, "the duplicate should win by reciprocal rank fusion");
	assert.equal(merged.fromCache, false);
	assert.equal(merged.source, "network");
});

test("mergeSearchOutcomes respects the result limit and cache state", () => {
	const first = outcome("deepseek", [
		item({ url: "https://one.example/" }),
		item({ url: "https://two.example/" }),
	]);
	first.fromCache = true;
	first.source = "cache";
	const second = outcome("exa", [item({ url: "https://three.example/" })]);
	second.fromCache = true;
	second.source = "cache";

	const merged = mergeSearchOutcomes([first, second], 2);
	assert.equal(merged.results.length, 2);
	assert.equal(merged.fromCache, true);
	assert.equal(merged.source, "cache");
});

test("canonicalResultUrl preserves trailing slashes in query values", () => {
	assert.notEqual(canonicalResultUrl("https://example.com/?path=/"), canonicalResultUrl("https://example.com/?path="));
	assert.equal(canonicalResultUrl("https://example.com/path/?x=1#part"), "https://example.com/path?x=1");
});

test("duplicate URLs from one provider cannot outweigh agreement between providers", () => {
	const merged = mergeSearchOutcomes([
		outcome("deepseek", [
			item({ url: "https://duplicate.example/" }),
			item({ url: "https://duplicate.example/#part" }),
			item({ url: "https://shared.example/" }),
		]),
		outcome("exa", [item({ url: "https://shared.example/" })]),
	], 10);
	assert.equal(merged.results[0]!.url, "https://shared.example/");
	assert.equal(merged.results.length, 2);
});

test("canonicalResultUrl removes fragments and trailing slashes", () => {
	assert.equal(
		canonicalResultUrl("https://Example.com/path/#section"),
		"https://example.com/path",
	);
});
