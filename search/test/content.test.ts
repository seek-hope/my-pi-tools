import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile, symlink, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	cleanupSpillFiles,
	cutToBytes,
	formatBytes,
	oneLine,
	spillToTempFile,
	truncateText,
} from "../src/content.ts";

test("truncateText keeps text within both budgets", () => {
	const text = "a".repeat(100) + "\n" + "b".repeat(100) + "\n" + "c".repeat(100);
	const byLine = truncateText(text, { maxBytes: 10_000, maxLines: 2 });
	assert.equal(byLine.truncated, true);
	assert.equal(byLine.shownLines, 2);
	assert.equal(byLine.text.includes("ccc"), false);

	const byBytes = truncateText(text, { maxBytes: 50, maxLines: 10_000 });
	assert.equal(byBytes.truncated, true);
	assert.ok(byBytes.shownBytes <= 50);
});

test("truncateText leaves small content untouched", () => {
	const result = truncateText("hello\nworld", { maxBytes: 100, maxLines: 10 });
	assert.equal(result.truncated, false);
	assert.equal(result.text, "hello\nworld");
	assert.equal(result.originalLines, 2);
});

test("cutToBytes never splits a multi-byte code point", () => {
	const text = "a😀b😀c";
	const cut = cutToBytes(text, 5); // "a" + 4-byte emoji = 5 bytes exactly
	assert.equal(cut, "a😀");
	assert.equal(Buffer.byteLength(cut, "utf8"), 5);
	assert.equal(cut.includes("\uFFFD"), false);

	const partial = cutToBytes(text, 4); // would split the emoji
	assert.equal(partial.includes("\uFFFD"), false);
	assert.ok(Buffer.byteLength(partial, "utf8") <= 4);
	assert.equal(cutToBytes("a\uFFFDrest", 4), "a\uFFFD", "preserve an actual replacement character at the boundary");
});

test("oneLine collapses whitespace and clamps length", () => {
	assert.equal(oneLine("  a\n\n b\tc  ", 20), "a b c");
	assert.equal(oneLine("abcdef", 4), "abc…");
});

test("formatBytes picks readable units", () => {
	assert.equal(formatBytes(10), "10 B");
	assert.equal(formatBytes(2048), "2.0 KB");
	assert.equal(formatBytes(2 * 1024 * 1024), "2.00 MB");
});

test("spillToTempFile writes private readable content", async () => {
	const content = `# Title\n\n${"body\n".repeat(1_000)}`;
	const path = await spillToTempFile(content, "unit-test");
	const written = await readFile(path, "utf8");
	assert.equal(written, content);
	const info = await stat(path);
	assert.equal(info.mode & 0o077, 0, "file should not be group/world readable");
});

test("spill writes and cleanup refuse a symlinked directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-spill-link-test-"));
	const target = join(root, "unrelated");
	const link = join(root, "pi-deepseek-web");
	const previousTmp = process.env.TMPDIR;
	try {
		await mkdir(target);
		await writeFile(join(target, "retain.md"), "unrelated data");
		await symlink(target, link, "dir");
		await cleanupSpillFiles({ dir: link, maxFiles: 0 });
		assert.equal(await readFile(join(target, "retain.md"), "utf8"), "unrelated data");
		process.env.TMPDIR = root;
		await assert.rejects(spillToTempFile("must not write outside spill directory"), /unsafe spill directory/i);
		assert.deepEqual(await readdir(target), ["retain.md"]);
	} finally {
		if (previousTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmp;
		await rm(root, { recursive: true, force: true });
	}
});

test("cleanupSpillFiles removes expired files and caps the directory", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-deepseek-spill-test-"));
	try {
		const old = join(dir, "old.md");
		const fresh = join(dir, "fresh.md");
		const extra = join(dir, "extra.md");
		await writeFile(old, "old");
		await writeFile(fresh, "fresh");
		await writeFile(extra, "extra");
		const now = Date.now();
		const day = 24 * 60 * 60_000;
		await utimes(old, new Date(now - 2 * day), new Date(now - 2 * day));
		await utimes(fresh, new Date(now - 1_000), new Date(now - 1_000));
		await utimes(extra, new Date(now - 2_000), new Date(now - 2_000));

		await cleanupSpillFiles({ dir, now, maxAgeMs: day, maxFiles: 1 });

		await assert.rejects(readFile(old), /ENOENT/);
		await assert.rejects(readFile(extra), /ENOENT/);
		assert.equal(await readFile(fresh, "utf8"), "fresh");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
