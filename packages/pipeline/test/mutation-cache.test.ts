import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MutationCache, type MutationCacheKey } from "../src/mutation-cache.ts";
import { mutationInstallation } from "../src/mutation-static.ts";

const key = (changes: Partial<MutationCacheKey> = {}): MutationCacheKey => ({
	policy: "policy",
	trusted: false,
	head: "head",
	inputs: "inputs",
	installation: "installation",
	...changes,
});

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "melian-incremental-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("reopens what the previous run wrote without sharing across policy or writer trust", async () => {
	const first = await MutationCache.open(root, key({ trusted: false }));
	await writeFile(first.file, JSON.stringify({ files: { a: { mutants: [] } } }));
	const second = await MutationCache.open(root, key({ trusted: false }));
	expect(second.file).toBe(first.file);
	expect(JSON.parse(await readFile(second.file, "utf8"))).toEqual({ files: { a: { mutants: [] } } });
	const trusted = await MutationCache.open(root, key({ trusted: true }));
	expect(trusted.file).not.toBe(first.file);
	await expect(stat(trusted.file)).rejects.toMatchObject({ code: "ENOENT" });
	const changed = await MutationCache.open(root, key({ trusted: false, policy: "next-policy" }));
	expect(changed.file).not.toBe(first.file);
	const other = await MutationCache.open(join(root, "other-repository"), key({ trusted: false }));
	expect(other.file).not.toBe(first.file);
});

it("discards corrupt output before the next run can read it", async () => {
	const first = await MutationCache.open(root, key({ trusted: true }));
	await writeFile(first.file, "{corrupt");
	const second = await MutationCache.open(root, key({ trusted: true }));
	await expect(stat(second.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses a symlink into another writer partition without removing its target", async () => {
	const untrusted = await MutationCache.open(root, key({ trusted: false }));
	const trusted = await MutationCache.open(root, key({ trusted: true }));
	await writeFile(untrusted.file, "{}");
	await symlink(untrusted.file, trusted.file);
	await MutationCache.open(root, key({ trusted: true }));
	await expect(stat(trusted.file)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(untrusted.file, "utf8")).toBe("{}");
});

it("keeps a parsed report at the read bound and discards one byte past it", async () => {
	const cache = await MutationCache.open(root, key({ trusted: true }));
	const text = "{}".padEnd(16 * 1024 * 1024, " ");
	await writeFile(cache.file, text);
	await MutationCache.open(root, key({ trusted: true }));
	expect((await readFile(cache.file)).length).toBe(text.length);
	await writeFile(cache.file, `${text} `);
	await MutationCache.open(root, key({ trusted: true }));
	await expect(stat(cache.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("sweeps old partial cache writes while keeping the incremental report", async () => {
	const cache = await MutationCache.open(root, key({ trusted: true }));
	await writeFile(cache.file, "{}");
	const stale = join(cache.directory, `incremental.json.2147483647.${crypto.randomUUID()}.tmp`);
	await writeFile(stale, "partial");
	await MutationCache.open(root, key({ trusted: true }));
	await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(cache.file, "utf8")).toBe("{}");
});

it("discards a non-file occupying the report path", async () => {
	const cache = await MutationCache.open(root, key({ trusted: true }));
	await mkdir(cache.file);
	await MutationCache.open(root, key({ trusted: true }));
	await expect(stat(cache.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps one partition per head commit and per run input", async () => {
	const first = await MutationCache.open(root, key());
	expect((await MutationCache.open(root, key())).file).toBe(first.file);
	expect((await MutationCache.open(root, key({ head: "other-head" }))).file).not.toBe(first.file);
	expect((await MutationCache.open(root, key({ inputs: "other-inputs" }))).file).not.toBe(first.file);
});

it("starts cold when the checkout lockfile changes at the same head", async () => {
	await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
	const first = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
	await writeFile(first.file, '{"files":{"a":{"mutants":[{"status":"Killed"}]}}}');
	const warm = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
	expect(await readFile(warm.file, "utf8")).toContain("Killed");
	await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{"new":{}}}');
	const cold = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
	await expect(stat(cold.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["@stryker-mutator/core", "@stryker-mutator/vitest-runner", "vitest"])(
	"starts cold when the resolved %s version changes with the same lockfile",
	async (name) => {
		await writeFile(join(root, "package-lock.json"), "{}");
		const directory = join(root, "node_modules", name);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "package.json"), '{"version":"1.0.0"}');
		const first = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
		await writeFile(first.file, "{}");
		await writeFile(join(directory, "package.json"), '{"version":"2.0.0"}');
		const cold = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
		await expect(stat(cold.file)).rejects.toMatchObject({ code: "ENOENT" });
	},
);

it.each(['{"version":42}', "{corrupt"])("treats an invalid installed version as unavailable: %s", async (text) => {
	const missing = mutationInstallation(root);
	const directory = join(root, "node_modules/@stryker-mutator/core");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), text);
	expect(mutationInstallation(root)).toBe(missing);
});

it("stages a copy of the partition's report and leaves the partition alone while the run writes it", async () => {
	const cache = await MutationCache.open(root, key());
	await writeFile(cache.file, '{"a":1}');
	const staged = await cache.stage(join(root, "work"));
	expect(staged).not.toBe(cache.file);
	expect(await readFile(staged, "utf8")).toBe('{"a":1}');
	await writeFile(staged, '{"a":2}');
	expect(await readFile(cache.file, "utf8")).toBe('{"a":1}');
});

it("stages nothing when the partition has no report, and replaces a stale staged file", async () => {
	const cache = await MutationCache.open(root, key());
	await mkdir(join(root, "work"));
	await writeFile(join(root, "work", "incremental.json"), '{"stale":true}');
	const staged = await cache.stage(join(root, "work"));
	await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
});

it("publishes a readable staged report into the partition", async () => {
	const cache = await MutationCache.open(root, key());
	await writeFile(cache.file, '{"old":true}');
	const staged = await cache.stage(join(root, "work"));
	await writeFile(staged, '{"new":true}');
	await cache.publish(staged);
	expect(await readFile(cache.file, "utf8")).toBe('{"new":true}');
	expect((await readdir(cache.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("keeps the partition's report when the staged one is corrupt, missing, a symlink, or past the bound", async () => {
	const cache = await MutationCache.open(root, key());
	await writeFile(cache.file, '{"old":true}');
	await mkdir(join(root, "work"));
	const staged = join(root, "work", "incremental.json");
	await writeFile(staged, "{corrupt");
	await cache.publish(staged);
	await rm(staged);
	await cache.publish(staged);
	await writeFile(join(root, "target.json"), '{"forged":true}');
	await symlink(join(root, "target.json"), staged);
	await cache.publish(staged);
	await rm(staged);
	await writeFile(staged, `{}${" ".repeat(16 * 1024 * 1024)}`);
	await cache.publish(staged);
	expect(await readFile(cache.file, "utf8")).toBe('{"old":true}');
});

it("publishes a staged report of exactly the read bound", async () => {
	const cache = await MutationCache.open(root, key());
	await mkdir(join(root, "work"));
	const staged = join(root, "work", "incremental.json");
	await writeFile(staged, "{}".padEnd(16 * 1024 * 1024, " "));
	await cache.publish(staged);
	expect((await readFile(cache.file)).length).toBe(16 * 1024 * 1024);
});
