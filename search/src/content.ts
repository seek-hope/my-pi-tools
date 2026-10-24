/**
 * Model-facing content shaping: byte/line budgets and temp-file spill.
 *
 * Tool results are context, not logs. Truncating here keeps a huge page from
 * eating the conversation, and spilling the full text lets the model `read`
 * only the part it needs.
 */

import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TruncateOptions {
	maxBytes: number;
	maxLines: number;
}

export interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes: number;
	originalLines: number;
	shownBytes: number;
	shownLines: number;
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) lines += 1;
	}
	return lines;
}

export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function cutToBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (byteLength(text) <= maxBytes) return text;
	const buffer = Buffer.from(text, "utf8");
	let end = Math.floor(maxBytes);
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
	let out = buffer.subarray(0, end).toString("utf8");
	const newline = out.lastIndexOf("\n");
	if (newline > 0 && newline >= maxBytes * 0.5) {
		out = out.slice(0, newline);
	}
	return out;
}

/** Apply line and byte budgets, whichever is hit first. */
export function truncateText(input: string, options: TruncateOptions): TruncationResult {
	const originalBytes = byteLength(input);
	const originalLines = countLines(input);
	let text = input;
	let truncated = false;
	const hasByteBudget = options.maxBytes > 0;
	const hasLineBudget = options.maxLines > 0;

	if (hasLineBudget && originalLines > options.maxLines) {
		text = text.split("\n").slice(0, options.maxLines).join("\n");
		truncated = true;
	}
	if (hasByteBudget && byteLength(text) > options.maxBytes) {
		text = cutToBytes(text, options.maxBytes);
		truncated = true;
	}

	return {
		text,
		truncated,
		originalBytes,
		originalLines,
		shownBytes: byteLength(text),
		shownLines: countLines(text),
	};
}

const SPILL_DIR_NAME = "pi-deepseek-web";
const SPILL_MAX_AGE_MS = 24 * 60 * 60_000;
const SPILL_MAX_FILES = 100;
const SPILL_CLEANUP_INTERVAL_MS = 60 * 60_000;
let lastCleanup = 0;

export interface SpillCleanupOptions {
	dir?: string;
	now?: number;
	maxAgeMs?: number;
	maxFiles?: number;
}

async function assertSpillDirectory(dir: string): Promise<void> {
	const info = await lstat(dir);
	if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
		throw new Error("Unsafe spill directory: expected a real directory owned by the current user");
	}
}

/** Remove expired spill files and cap the directory; failures are best-effort. */
export async function cleanupSpillFiles(options: SpillCleanupOptions = {}): Promise<void> {
	const dir = options.dir ?? join(tmpdir(), SPILL_DIR_NAME);
	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? SPILL_MAX_AGE_MS;
	const maxFiles = Math.max(0, options.maxFiles ?? SPILL_MAX_FILES);
	try {
		await assertSpillDirectory(dir);
		const entries = await readdir(dir, { withFileTypes: true });
		const files: Array<{ path: string; mtimeMs: number }> = [];
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const path = join(dir, entry.name);
			try {
				const info = await stat(path);
				if (now - info.mtimeMs > maxAgeMs) {
					await rm(path, { force: true });
					continue;
				}
				files.push({ path, mtimeMs: info.mtimeMs });
			} catch {
				// A concurrent cleanup may have removed it already.
			}
		}
		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const file of files.slice(maxFiles)) await rm(file.path, { force: true });
	} catch {
		// Missing, unreadable or unsafe spill directory: leave it untouched.
	}
}

/** Write the full content under a private temp directory and return its path. */
export async function spillToTempFile(content: string, prefix = "page"): Promise<string> {
	const dir = join(tmpdir(), SPILL_DIR_NAME);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await assertSpillDirectory(dir);
	// `mode` only applies on creation; repair an owned directory before writing.
	await chmod(dir, 0o700);
	const now = Date.now();
	if (now - lastCleanup >= SPILL_CLEANUP_INTERVAL_MS) {
		lastCleanup = now;
		await cleanupSpillFiles({ dir, now });
	}
	const safePrefix = prefix.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 24) || "page";
	const name = `${safePrefix}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.md`;
	const path = join(dir, name);
	await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return path;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Collapse whitespace for one-line summaries. */
export function oneLine(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxChars) return collapsed;
	return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
