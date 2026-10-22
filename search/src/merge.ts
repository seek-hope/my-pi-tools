/**
 * Merge search results from multiple providers.
 *
 * Exa and DeepSeek use different relevance scales, so scores are not compared
 * directly. Reciprocal rank fusion (RRF) uses each provider's ordering and is
 * stable when one provider returns more or fewer results.
 */

import type { SearchOutcome, SearchProvider, SearchResultItem } from "./deepseek.ts";

const RRF_K = 60;
const PROVIDER_ORDER: SearchProvider[] = ["deepseek", "exa"];

export function canonicalResultUrl(raw: string): string {
	try {
		const url = new URL(raw);
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return raw;
	}
}

function providerOf(outcome: SearchOutcome): SearchProvider {
	return outcome.providers?.[0] ?? outcome.results[0]?.provider ?? "deepseek";
}

function uniqueProviders(providers: Iterable<SearchProvider>): SearchProvider[] {
	const set = new Set(providers);
	return PROVIDER_ORDER.filter((provider) => set.has(provider));
}

export function mergeSearchOutcomes(outcomes: SearchOutcome[], limit: number): SearchOutcome {
	if (outcomes.length === 0) {
		throw new Error("mergeSearchOutcomes requires at least one outcome");
	}

	const merged = new Map<
		string,
		{ item: SearchResultItem; score: number; providers: Set<SearchProvider>; firstSeen: number }
	>();
	let firstSeen = 0;

	for (const outcome of outcomes) {
		const provider = providerOf(outcome);
		outcome.results.forEach((result, index) => {
			const key = canonicalResultUrl(result.url);
			const points = 1 / (RRF_K + index + 1);
			const current = merged.get(key);
			if (!current) {
				merged.set(key, {
					item: {
						...result,
						provider,
						providers: [provider],
					},
					score: points,
					providers: new Set([provider]),
					firstSeen: firstSeen++,
				});
				return;
			}

			current.score += points;
			current.providers.add(provider);
			current.item.providers = uniqueProviders(current.providers);
			if (!current.item.snippet && result.snippet) current.item.snippet = result.snippet;
			if (!current.item.summary && result.summary) current.item.summary = result.summary;
			if (!current.item.content && result.content) current.item.content = result.content;
			if (!current.item.date && result.date) current.item.date = result.date;
			if (current.item.authority < 0 && result.authority >= 0) {
				current.item.authority = result.authority;
			}
			if (!current.item.rerank_score && result.rerank_score) {
				current.item.rerank_score = result.rerank_score;
			}
		});
	}

	const results = [...merged.values()]
		.sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
		.slice(0, Math.max(1, limit))
		.map(({ item, providers }) => {
			const ordered = uniqueProviders(providers);
			return {
				...item,
				provider: ordered[0] ?? item.provider,
				providers: ordered,
			};
		});

	const allProviders = uniqueProviders(
		outcomes.flatMap((outcome) => outcome.providers ?? [providerOf(outcome)]),
	);
	const warnings = [...new Set(outcomes.flatMap((outcome) => outcome.warnings ?? []))];

	return {
		results,
		fromCache: outcomes.every((outcome) => outcome.fromCache),
		source: outcomes.every((outcome) => outcome.fromCache) ? "cache" : "network",
		durationMs: Math.max(...outcomes.map((outcome) => outcome.durationMs)),
		providers: allProviders,
		warnings,
	};
}
