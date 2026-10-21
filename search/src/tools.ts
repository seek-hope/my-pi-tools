/**
 * Tool registration and model-facing formatting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { WebToolsConfig } from "./config.ts";
import { formatBytes, oneLine, spillToTempFile, truncateText } from "./content.ts";
import type { DeepSeekClient, FetchOutcome, SearchOutcome } from "./deepseek.ts";
import { toWebToolError } from "./errors.ts";

export interface WebToolDeps {
	getClient: () => Promise<DeepSeekClient>;
	config: WebToolsConfig;
}

type ToolErrorDetails = {
	error: {
		kind: string;
		status: number | null;
		retryable: boolean;
		message: string;
	};
};

type SearchDetails = {
	tool: "web_search";
	query: string;
	count: number;
	needContent: boolean;
	resultCount: number;
	fromCache: boolean;
	truncated: boolean;
	durationMs: number;
	results: Array<{
		title: string;
		url: string;
		site: string | null;
		date: string | null;
		authority: number;
		score: number;
	}>;
};

type FetchDetails = {
	tool: "web_fetch";
	url: string;
	title: string;
	bytes: number;
	lines: number;
	truncated: boolean;
	fullPath: string | null;
	fromCache: boolean;
	durationMs: number;
};

type WebToolDetails = SearchDetails | FetchDetails | ToolErrorDetails;

const SEARCH_PARAMS = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			maxLength: 128,
			description: "Search query (1–128 characters). Supports site:, -site: and quoted phrases.",
		}),
		count: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 50,
				default: 10,
				description: "Number of results to return (1–50, default 10).",
			}),
		),
		need_content: Type.Optional(
			Type.Boolean({
				default: false,
				description:
					"Include each page's extracted content. Costs more tokens; prefer false and use web_fetch for the pages you need.",
			}),
		),
		ori_question: Type.Optional(
			Type.String({
				maxLength: 128,
				description: "The user's original question, which helps the search engine understand intent.",
			}),
		),
	},
	{ additionalProperties: false },
);

const FETCH_PARAMS = Type.Object(
	{
		url: Type.String({
			minLength: 1,
			maxLength: 8192,
			description: "Absolute http(s) URL to fetch. Private, loopback and metadata hosts are blocked.",
		}),
	},
	{ additionalProperties: false },
);

function resultDetails(details: unknown): WebToolDetails | undefined {
	if (!details || typeof details !== "object") return undefined;
	return details as WebToolDetails;
}

function isErrorDetails(details: WebToolDetails | undefined): details is ToolErrorDetails {
	return details !== undefined && "error" in details;
}

function siteLabel(url: string, siteName: string | null): string {
	if (siteName) return siteName;
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function formatDate(value: string | null): string | undefined {
	if (!value) return undefined;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
	return parsed.toISOString().slice(0, 10);
}

export function formatSearchResults(outcome: SearchOutcome, config: WebToolsConfig): {
	text: string;
	truncated: boolean;
} {
	const { results } = outcome;
	if (results.length === 0) {
		const cacheNote = outcome.fromCache ? " (cached)" : "";
		return {
			text: `No web results${cacheNote}. Try a broader query or different keywords.`,
			truncated: false,
		};
	}

	const header = [
		`Found ${results.length} result${results.length === 1 ? "" : "s"}`,
		outcome.fromCache ? "cached" : "",
		`${outcome.durationMs} ms`,
	]
		.filter(Boolean)
		.join(" · ");

	const perResultBudget =
		results.length > 0 ? Math.max(600, Math.floor((config.maxResultBytes * 0.8) / results.length)) : 0;
	const blocks: string[] = [header];

	results.forEach((result, index) => {
		const meta = [
			siteLabel(result.url, result.site_name),
			formatDate(result.date),
			result.authority >= 0 ? `authority ${result.authority}` : undefined,
			result.rerank_score > 0 ? `score ${result.rerank_score.toFixed(1)}` : undefined,
		]
			.filter((part): part is string => Boolean(part))
			.join(" · ");

		const lines = [
			`${index + 1}. ${result.title || result.url}`,
			`   ${result.url}`,
			`   ${oneLine(result.summary || result.snippet || "(no summary)", config.maxSnippetChars)}`,
		];
		if (meta) lines.push(`   ${meta}`);
		if (config.maxResultBytes > 0 && result.content) {
			const content = truncateText(result.content, {
				maxBytes: perResultBudget,
				maxLines: Math.max(20, Math.floor(config.maxResultLines / results.length)),
			});
			lines.push(`   Content (${formatBytes(content.shownBytes)}${content.truncated ? ", truncated" : ""}):`);
			lines.push(
				content.text
					.split("\n")
					.map((line) => `   ${line}`)
					.join("\n"),
			);
		}
		blocks.push(lines.join("\n"));
	});

	const truncated = truncateText(blocks.join("\n\n"), {
		maxBytes: config.maxResultBytes,
		maxLines: config.maxResultLines,
	});
	if (!truncated.truncated) {
		return { text: truncated.text, truncated: false };
	}
	return {
		text: `${truncated.text}\n\n[search output truncated: showing ${formatBytes(
			truncated.shownBytes,
		)} of ${formatBytes(truncated.originalBytes)}. Narrow the query or fetch a specific URL for details.]`,
		truncated: true,
	};
}

export async function formatFetchResult(
	outcome: FetchOutcome,
	config: WebToolsConfig,
): Promise<{ text: string; details: FetchDetails }> {
	const body = outcome.content.trim()
		? outcome.content
		: "(The fetcher returned no readable page content.)";
	const document = `# ${outcome.title || outcome.url}\n\n${body}`;
	const truncated = truncateText(document, {
		maxBytes: config.maxResultBytes,
		maxLines: config.maxResultLines,
	});

	let text = truncated.text;
	let fullPath: string | null = null;
	if (truncated.truncated && config.spillToTempFile) {
		try {
			fullPath = await spillToTempFile(document, "web-fetch");
		} catch {
			fullPath = null;
		}
	}

	if (truncated.truncated) {
		const parts = [
			`[page truncated: showing ${formatBytes(truncated.shownBytes)} of ${formatBytes(
				truncated.originalBytes,
			)} (${truncated.shownLines}/${truncated.originalLines} lines)]`,
		];
		if (fullPath) {
			parts.push(`Full content saved to ${fullPath} — use read with offset/limit to continue.`);
		}
		text = `${text}\n\n${parts.join("\n")}`;
	}

	return {
		text,
		details: {
			tool: "web_fetch",
			url: outcome.url,
			title: outcome.title,
			bytes: truncated.originalBytes,
			lines: truncated.originalLines,
			truncated: truncated.truncated,
			fullPath,
			fromCache: outcome.fromCache,
			durationMs: outcome.durationMs,
		},
	};
}

function errorResult(toolName: string, error: unknown) {
	const normalized = toWebToolError(error);
	return {
		content: [{ type: "text" as const, text: normalized.toModelText(toolName) }],
		details: { error: normalized.toDetails() } satisfies ToolErrorDetails,
		isError: true,
	};
}

export function registerWebTools(pi: ExtensionAPI, deps: WebToolDeps): void {
	const { config } = deps;

	pi.registerTool<typeof SEARCH_PARAMS, WebToolDetails>({
		name: "web_search",
		label: "Web search",
		description: `Search the web through DeepSeek's search engine and return ranked results (title, URL, summary, site, date, authority). Use need_content=false first and call web_fetch for pages that matter. Results are cached for ${Math.round(
			config.searchCacheTtlMs / 1000,
		)}s.`,
		promptSnippet: "Search the web via DeepSeek and get ranked results with URLs and summaries",
		promptGuidelines: [
			"Use web_search for current events, external documentation or facts not present in the repository.",
			"Prefer a short, specific query and follow up with web_fetch on the most relevant URL.",
		],
		parameters: SEARCH_PARAMS,
		executionMode: "parallel",

		async execute(_toolCallId, params, signal) {
			const toolName = "web_search";
			try {
				const client = await deps.getClient();
				const outcome = await client.search(
					{
						query: params.query,
						count: params.count,
						need_content: params.need_content,
						ori_question: params.ori_question,
					},
					signal,
				);
				const formatted = formatSearchResults(outcome, config);
				const details: SearchDetails = {
					tool: "web_search",
					query: params.query,
					count: params.count ?? 10,
					needContent: params.need_content === true,
					resultCount: outcome.results.length,
					fromCache: outcome.fromCache,
					truncated: formatted.truncated,
					durationMs: outcome.durationMs,
					results: outcome.results.map((result) => ({
						title: result.title,
						url: result.url,
						site: result.site_name,
						date: result.date,
						authority: result.authority,
						score: result.rerank_score,
					})),
				};
				return { content: [{ type: "text", text: formatted.text }], details };
			} catch (error) {
				return errorResult(toolName, error);
			}
		},

		renderCall(args, theme) {
			const query = typeof args.query === "string" ? args.query : "";
			let line = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", `"${query}"`);
			if (args.need_content) line += theme.fg("dim", " +content");
			if (typeof args.count === "number" && args.count !== 10) line += theme.fg("dim", ` ×${args.count}`);
			return new Text(line, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "searching the web…"), 0, 0);
			const details = resultDetails(result.details);
			if (isErrorDetails(details)) {
				return new Text(
					theme.fg("error", `web_search failed: ${details.error.kind} — ${details.error.message}`),
					0,
					0,
				);
			}
			if (!details || details.tool !== "web_search") {
				return new Text(theme.fg("muted", "web_search: no details"), 0, 0);
			}
			const bits = [
				`${details.resultCount} result${details.resultCount === 1 ? "" : "s"}`,
				`${details.durationMs} ms`,
				details.fromCache ? "cached" : "",
				details.truncated ? "truncated" : "",
			].filter(Boolean);
			let line = theme.fg("success", "✓ ") + theme.fg("muted", bits.join(" · "));
			if (expanded) {
				const top = details.results.slice(0, 8);
				line +=
					"\n" +
					top
						.map((item, index) => {
							const host = siteLabel(item.url, item.site);
							return theme.fg("dim", `  ${index + 1}. `) + theme.fg("text", item.title) + theme.fg("muted", ` — ${host}`);
						})
						.join("\n");
			}
			return new Text(line, 0, 0);
		},
	});

	pi.registerTool<typeof FETCH_PARAMS, WebToolDetails>({
		name: "web_fetch",
		label: "Web fetch",
		description: `Fetch one http(s) page through DeepSeek and return its title and Markdown content. Output is truncated to ${formatBytes(
			config.maxResultBytes,
		)} / ${config.maxResultLines} lines; the full text is saved to a temp file for follow-up reads. Private and metadata hosts are blocked. Pages are cached for ${Math.round(
			config.fetchCacheTtlMs / 1000,
		)}s.`,
		promptSnippet: "Fetch a web page as Markdown via DeepSeek (SSRF-guarded, truncated, cached)",
		promptGuidelines: [
			"Use web_fetch when you already have a specific URL, especially one returned by web_search.",
			"If the result is truncated, read the saved temp file with offset/limit instead of refetching.",
		],
		parameters: FETCH_PARAMS,
		executionMode: "parallel",

		async execute(_toolCallId, params, signal) {
			try {
				const client = await deps.getClient();
				const outcome = await client.fetchPage(params.url, signal);
				const formatted = await formatFetchResult(outcome, config);
				return {
					content: [{ type: "text", text: formatted.text }],
					details: formatted.details,
				};
			} catch (error) {
				return errorResult("web_fetch", error);
			}
		},

		renderCall(args, theme) {
			const url = typeof args.url === "string" ? args.url : "";
			return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", url), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "fetching page…"), 0, 0);
			const details = resultDetails(result.details);
			if (isErrorDetails(details)) {
				return new Text(
					theme.fg("error", `web_fetch failed: ${details.error.kind} — ${details.error.message}`),
					0,
					0,
				);
			}
			if (!details || details.tool !== "web_fetch") {
				return new Text(theme.fg("muted", "web_fetch: no details"), 0, 0);
			}
			const bits = [
				details.title || details.url,
				formatBytes(details.bytes),
				`${details.lines} lines`,
				details.fromCache ? "cached" : "",
				details.truncated ? "truncated" : "",
			].filter(Boolean);
			let line = theme.fg("success", "✓ ") + theme.fg("muted", bits.join(" · "));
			if (expanded) {
				line += `\n${theme.fg("dim", `  ${details.url}`)}`;
				if (details.fullPath) line += `\n${theme.fg("dim", `  full: ${details.fullPath}`)}`;
			}
			return new Text(line, 0, 0);
		},
	});
}

