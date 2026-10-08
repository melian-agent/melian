import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MutationCache } from "../src/mutation-cache.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "melian-incremental-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("reopens what the previous run wrote without sharing across policy or writer trust", async () => {
	const first = await MutationCache.open(root, "policy", false);
	await writeFile(first.file, JSON.stringify({ files: { a: { mutants: [] } } }));
	const second = await MutationCache.open(root, "policy", false);
	expect(second.file).toBe(first.file);
	expect(JSON.parse(await readFile(second.file, "utf8"))).toEqual({ files: { a: { mutants: [] } } });
	const trusted = await MutationCache.open(root, "policy", true);
	expect(trusted.file).not.toBe(first.file);
	await expect(stat(trusted.file)).rejects.toMatchObject({ code: "ENOENT" });
	const changed = await MutationCache.open(root, "next-policy", false);
	expect(changed.file).not.toBe(first.file);
	const other = await MutationCache.open(join(root, "other-repository"), "policy", false);
	expect(other.file).not.toBe(first.file);
});

it("discards corrupt output before the next run can read it", async () => {
	const first = await MutationCache.open(root, "policy", true);
	await writeFile(first.file, "{corrupt");
	const second = await MutationCache.open(root, "policy", true);
	await expect(stat(second.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses a symlink into another writer partition without removing its target", async () => {
	const untrusted = await MutationCache.open(root, "policy", false);
	const trusted = await MutationCache.open(root, "policy", true);
	await writeFile(untrusted.file, "{}");
	await symlink(untrusted.file, trusted.file);
	await MutationCache.open(root, "policy", true);
	await expect(stat(trusted.file)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(untrusted.file, "utf8")).toBe("{}");
});

it("keeps a parsed report at the read bound and discards one byte past it", async () => {
	const cache = await MutationCache.open(root, "policy", true);
	const text = "{}".padEnd(16 * 1024 * 1024, " ");
	await writeFile(cache.file, text);
	await MutationCache.open(root, "policy", true);
	expect((await readFile(cache.file)).length).toBe(text.length);
	await writeFile(cache.file, `${text} `);
	await MutationCache.open(root, "policy", true);
	await expect(stat(cache.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("sweeps old partial cache writes while keeping the incremental report", async () => {
	const cache = await MutationCache.open(root, "policy", true);
	await writeFile(cache.file, "{}");
	const stale = join(cache.directory, `incremental.json.2147483647.${crypto.randomUUID()}.tmp`);
	await writeFile(stale, "partial");
	await MutationCache.open(root, "policy", true);
	await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(cache.file, "utf8")).toBe("{}");
});

it("discards a non-file occupying the report path", async () => {
	const cache = await MutationCache.open(root, "policy", true);
	await mkdir(cache.file);
	await MutationCache.open(root, "policy", true);
	await expect(stat(cache.file)).rejects.toMatchObject({ code: "ENOENT" });
});
