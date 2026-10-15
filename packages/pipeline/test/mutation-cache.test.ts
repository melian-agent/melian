import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type * as filesystem from "node:fs/promises";
import {
	type FileHandle,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationCache, type MutationCacheKey } from "../src/mutation-cache.ts";
import { mutationInstallation } from "../src/mutation-static.ts";
import { mutationSelectionVersion } from "../src/mutation-vitest.ts";
import { MutationCache as MutationCacheV1 } from "./fixtures/mutation-cache-v1.ts";
import { MutationCache as MutationCacheV2 } from "./fixtures/mutation-cache-v2.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof filesystem>();
	return { ...original, open: vi.fn(original.open) };
});

const key = (changes: Partial<MutationCacheKey> = {}): MutationCacheKey => ({
	base: "base",
	policy: "policy",
	target: "range-feature",
	inputs: "inputs",
	installation: "installation",
	...changes,
});

const judged = "a".repeat(40);
// A partition as `publish` writes it.
const partition = (report: object, head: unknown = judged, trust: unknown = "writer") =>
	JSON.stringify({ version: 3, head, trust, report });
const always = async () => true;

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "melian-incremental-")));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("reopens what the previous run wrote without sharing across base, policy, target, or repository", async () => {
	const first = await MutationCache.open(root, key());
	await writeFile(first.file, partition({ files: { a: { mutants: [] } } }));
	const second = await MutationCache.open(root, key());
	expect(second.file).toBe(first.file);
	expect(await second.earlier("writer", always)).toEqual({
		judged: { head: judged, trust: "writer" },
		report: JSON.stringify({ files: { a: { mutants: [] } } }),
	});
	for (const changed of [key({ base: "next-base" }), key({ policy: "next-policy" }), key({ target: "pull-other" })]) {
		const cache = await MutationCache.open(root, changed);
		expect(cache.file).not.toBe(first.file);
		await expect(stat(cache.file)).rejects.toMatchObject({ code: "ENOENT" });
	}
	const other = await MutationCache.open(join(root, "other-repository"), key());
	expect(other.file).not.toBe(first.file);
});

it("discards corrupt output before the next run can read it", async () => {
	const first = await MutationCache.open(root, key());
	await writeFile(first.file, "{corrupt");
	const second = await MutationCache.open(root, key());
	await expect(stat(second.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
	["a head that is no commit", partition({}, "HEAD")],
	["a head that is not text", partition({}, 42)],
	["a head that is a list", partition({}, [judged])],
	["a report that is no object", JSON.stringify({ version: 3, head: judged, trust: "writer", report: "{}" })],
	["no report", JSON.stringify({ version: 3, head: judged, trust: "writer" })],
	["a document that is no object", "null"],
])("discards a partition with %s", async (_, text) => {
	const first = await MutationCache.open(root, key());
	await writeFile(first.file, text);
	const second = await MutationCache.open(root, key());
	await expect(stat(second.file)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await second.earlier("writer", always)).toEqual({ cold: "this review target has no earlier judged head" });
});

it.each(["valid", "corrupt", "oversized"])("closes the cache descriptor after reading %s output", async (kind) => {
	const cache = await MutationCache.open(root, key());
	const text = kind === "valid" ? partition({}) : kind === "corrupt" ? "{corrupt" : "{}".padEnd(17 * 1024 * 1024, " ");
	await writeFile(cache.file, text);
	const actual = vi.mocked(open).getMockImplementation()!;
	const files: FileHandle[] = [];
	vi.mocked(open).mockImplementation(async (path, flags, mode) => {
		const file = await actual(path, flags, mode);
		vi.spyOn(file, "close");
		files.push(file);
		return file;
	});
	try {
		await MutationCache.open(root, key());
		expect(files).toHaveLength(1);
		expect(files[0]!.close).toHaveBeenCalledTimes(1);
	} finally {
		vi.mocked(open).mockImplementation(actual);
		for (const file of files) await file.close();
		vi.restoreAllMocks();
	}
});

it("refuses a symlink into another partition without removing its target", async () => {
	const elsewhere = await MutationCache.open(root, key({ base: "other-base" }));
	const cache = await MutationCache.open(root, key());
	await writeFile(elsewhere.file, partition({}));
	await symlink(elsewhere.file, cache.file);
	await MutationCache.open(root, key());
	await expect(stat(cache.file)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(elsewhere.file, "utf8")).toBe(partition({}));
});

it("keeps a partition at the read bound and discards one byte past it", async () => {
	const cache = await MutationCache.open(root, key());
	const text = partition({}).padEnd(16 * 1024 * 1024 + 1024, " ");
	await writeFile(cache.file, text);
	await MutationCache.open(root, key());
	expect((await readFile(cache.file)).length).toBe(text.length);
	await writeFile(cache.file, `${text} `);
	await MutationCache.open(root, key());
	await expect(stat(cache.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("sweeps old partial cache writes while keeping the partition", async () => {
	const cache = await MutationCache.open(root, key());
	await writeFile(cache.file, partition({}));
	const stale = join(cache.directory, `partition.json.2147483647.${crypto.randomUUID()}.tmp`);
	await writeFile(stale, "partial");
	await MutationCache.open(root, key());
	await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(cache.file, "utf8")).toBe(partition({}));
});

it("discards a non-file occupying the partition path", async () => {
	const cache = await MutationCache.open(root, key());
	await mkdir(cache.file);
	await MutationCache.open(root, key());
	await expect(stat(cache.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps one partition per review target, base, policy and run input, whatever the head", async () => {
	const first = await MutationCache.open(root, key());
	expect((await MutationCache.open(root, key())).file).toBe(first.file);
	expect((await MutationCache.open(root, key({ target: "other-target" }))).file).not.toBe(first.file);
	expect((await MutationCache.open(root, key({ base: "other-base" }))).file).not.toBe(first.file);
	expect((await MutationCache.open(root, key({ policy: "other-policy" }))).file).not.toBe(first.file);
	expect((await MutationCache.open(root, key({ inputs: "other-inputs" }))).file).not.toBe(first.file);
});

describe("the last judged head", () => {
	it("is handed on when its run was trusted and it is in the new head's history", async () => {
		const cache = await MutationCache.open(root, key());
		await writeFile(cache.file, partition({ files: {} }, judged, "reviewer"));
		const asked: string[] = [];
		const earlier = await cache.earlier("reviewer", async (head) => {
			asked.push(head);
			return true;
		});
		expect(asked).toEqual([judged]);
		expect(earlier).toEqual({ judged: { head: judged, trust: "reviewer" }, report: '{"files":{}}' });
	});

	it("is not handed on once the history no longer holds it", async () => {
		const cache = await MutationCache.open(root, key());
		await writeFile(cache.file, partition({ files: {} }));
		expect(await cache.earlier("writer", async () => false)).toEqual({
			cold: "the last judged head aaaaaaaaaaaa is not in this head's history, which was rewritten",
		});
	});

	it.each([
		["reviewer", partition({ files: {} }, judged, "reviewer")],
		["fork", partition({ files: {} }, judged, "fork")],
		["true", partition({ files: {} }, judged, true)],
		["undefined", JSON.stringify({ version: 3, head: judged, report: { files: {} } })],
	])("is not handed on to a writer's run when its run's leave reads %s", async (leave, text) => {
		const cache = await MutationCache.open(root, key());
		await writeFile(cache.file, text);
		expect(await cache.earlier("writer", always)).toEqual({
			cold: `the run that judged aaaaaaaaaaaa was trusted as ${leave}, not as writer`,
		});
	});

	it("is not handed on to a reviewer-vouched run when a writer's run wrote it", async () => {
		const cache = await MutationCache.open(root, key());
		await writeFile(cache.file, partition({ files: {} }));
		expect(await cache.earlier("reviewer", always)).toEqual({
			cold: "the run that judged aaaaaaaaaaaa was trusted as writer, not as reviewer",
		});
	});
});

it("stages the earlier report twice, and the repeat's copy stays when the run rewrites the staged one", async () => {
	const cache = await MutationCache.open(root, key());
	const { staged, earlier } = await cache.stage(join(root, "work"), '{"a":1}');
	expect(staged).not.toBe(earlier);
	expect(await readFile(staged, "utf8")).toBe('{"a":1}');
	await writeFile(staged, '{"a":2}');
	expect(await readFile(earlier, "utf8")).toBe('{"a":1}');
});

it("stages nothing for a cold run, and replaces stale staged files and directories", async () => {
	const cache = await MutationCache.open(root, key());
	await mkdir(join(root, "work", "incremental.json", "inside"), { recursive: true });
	await writeFile(join(root, "work", "earlier.json"), '{"stale":true}');
	const { staged, earlier } = await cache.stage(join(root, "work"), undefined);
	await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(stat(earlier)).rejects.toMatchObject({ code: "ENOENT" });
});

it("publishes a readable staged report with the head that wrote it and its leave", async () => {
	const cache = await MutationCache.open(root, key());
	await writeFile(cache.file, partition({ old: true }));
	const { staged } = await cache.stage(join(root, "work"), undefined);
	await writeFile(staged, '{"new":true}');
	await cache.publish(staged, { head: "b".repeat(40), trust: "writer" });
	expect(JSON.parse(await readFile(cache.file, "utf8"))).toEqual({
		version: 3,
		head: "b".repeat(40),
		trust: "writer",
		report: { new: true },
	});
	expect((await readdir(cache.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("publishes the bytes it checked, not what the path names after the check", async () => {
	const cache = await MutationCache.open(root, key());
	const { staged } = await cache.stage(join(root, "work"), undefined);
	await writeFile(staged, '{"checked":true}');
	await writeFile(join(root, "forged.json"), '{"forged":true}');
	const real = vi.mocked(open).getMockImplementation()!;
	// The head's tests ran beside this file and may have left a process: it swaps the path the moment it is opened.
	vi.mocked(open).mockImplementation(async (path, ...rest) => {
		const handle = await real(path, ...rest);
		if (path === staged) {
			await rm(staged);
			await symlink(join(root, "forged.json"), staged);
		}
		return handle;
	});
	try {
		await cache.publish(staged, { head: judged, trust: "writer" });
	} finally {
		vi.mocked(open).mockImplementation(real);
	}
	expect(JSON.parse(await readFile(cache.file, "utf8")).report).toEqual({ checked: true });
});

it("keeps the partition when the staged report is corrupt, missing, a symlink, or past the bound", async () => {
	const cache = await MutationCache.open(root, key());
	await writeFile(cache.file, partition({ old: true }));
	await mkdir(join(root, "work"));
	const staged = join(root, "work", "incremental.json");
	const publish = () => cache.publish(staged, { head: "b".repeat(40), trust: "writer" });
	await writeFile(staged, "{corrupt");
	await publish();
	await rm(staged);
	await publish();
	await writeFile(join(root, "target.json"), '{"forged":true}');
	await symlink(join(root, "target.json"), staged);
	await publish();
	await rm(staged);
	await writeFile(staged, "{}".padEnd(16 * 1024 * 1024 + 1, " "));
	await publish();
	expect(await readFile(cache.file, "utf8")).toBe(partition({ old: true }));
});

it("publishes a staged report of exactly the read bound, and the next run reads it", async () => {
	const cache = await MutationCache.open(root, key());
	await mkdir(join(root, "work"));
	const staged = join(root, "work", "incremental.json");
	await writeFile(staged, "{}".padEnd(16 * 1024 * 1024, " "));
	await cache.publish(staged, { head: judged, trust: "writer" });
	expect(await (await MutationCache.open(root, key())).earlier("writer", always)).toMatchObject({ report: "{}" });
});

it.each(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"])(
	"starts cold when %s changes at the same head",
	async (name) => {
		await writeFile(join(root, name), "first");
		const first = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
		await writeFile(first.file, partition({ files: { a: { mutants: [{ status: "Killed" }] } } }));
		const warm = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
		expect(await readFile(warm.file, "utf8")).toContain("Killed");
		await writeFile(join(root, name), "second");
		const cold = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
		await expect(stat(cold.file)).rejects.toMatchObject({ code: "ENOENT" });
	},
);

it("does not reuse a partition written under the identity that hashed package-lock.json alone", async () => {
	await writeFile(join(root, "package-lock.json"), "{}");
	// The identity this pull request first shipped, copied as it was written.
	const versions = ["unavailable", "unavailable", "unavailable"];
	const lockfile = createHash("sha256").update("{}").digest("hex");
	const old = createHash("sha256")
		.update(
			JSON.stringify({
				lockfile,
				versions,
				node: process.versions.node,
				selectionVersion: mutationSelectionVersion,
			}),
		)
		.digest("hex");
	expect(mutationInstallation(root)).not.toBe(old);
});

it("starts cold when the Node runtime changes with the same head and installation", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
	try {
		const first = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
		await writeFile(first.file, partition({ files: { a: { mutants: [{ status: "Killed" }] } } }));
		const warm = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
		expect(await readFile(warm.file, "utf8")).toContain("Killed");
		Object.defineProperty(process.versions, "node", { ...descriptor, value: "26.0.0" });
		const cold = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
		expect(cold.file).not.toBe(first.file);
		await expect(stat(cold.file)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		Object.defineProperty(process.versions, "node", descriptor);
	}
});

it.each(["@stryker-mutator/core", "@stryker-mutator/vitest-runner", "vitest"])(
	"starts cold when the resolved %s version changes with the same lockfile",
	async (name) => {
		await writeFile(join(root, "package-lock.json"), "{}");
		const directory = join(root, "node_modules", name);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "package.json"), '{"version":"1.0.0"}');
		const first = await MutationCache.open(root, key({ installation: mutationInstallation(root) }));
		await writeFile(first.file, partition({}));
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

it("reopens a version-one cache without reusing its selection results", async () => {
	const keyV1 = { policy: "base", head: judged, inputs: "inputs", installation: "installation", trusted: false };
	const old = await MutationCacheV1.open(root, keyV1);
	const staged = await old.stage(join(root, "v1-stage"));
	await writeFile(staged, JSON.stringify({ files: { a: { mutants: [{ status: "NoCoverage" }] } } }));
	await old.publish(staged, { read: (path) => readFile(path, "utf8") });
	expect(await readFile((await MutationCacheV1.open(root, keyV1)).file, "utf8")).toContain("NoCoverage");
	const current = await MutationCache.open(root, key());
	expect(current.directory).not.toBe(old.directory);
	expect(await current.earlier("writer", always)).toEqual({ cold: "this review target has no earlier judged head" });
});

it("reopens a version-two cache, which kept one partition per head, without reusing it at a later head", async () => {
	const keyV2 = { policy: "base", head: judged, inputs: "inputs", installation: "installation" };
	const old = await MutationCacheV2.open(root, keyV2);
	const staged = await old.stage(join(root, "v2-stage"));
	await writeFile(staged, JSON.stringify({ files: { a: { mutants: [{ status: "Killed" }] } } }));
	await old.publish(staged);
	expect(await readFile((await MutationCacheV2.open(root, keyV2)).file, "utf8")).toContain("Killed");
	const current = await MutationCache.open(root, key());
	expect(current.directory).not.toBe(old.directory);
	expect(await current.earlier("writer", always)).toEqual({ cold: "this review target has no earlier judged head" });
});

it("changes the installation identity that the durable run key hashes after selection changes", () => {
	const checkout = process.cwd();
	const require = createRequire(join(checkout, "package.json"));
	const versions = ["@stryker-mutator/core", "@stryker-mutator/vitest-runner", "vitest"].map(
		(name) =>
			(JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")) as { version: string }).version,
	);
	const lockfiles = Object.fromEntries(
		["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].map((name) => [
			name,
			existsSync(join(checkout, name))
				? createHash("sha256")
						.update(readFileSync(join(checkout, name)))
						.digest("hex")
				: "unavailable",
		]),
	);
	const identity = (selection: object) =>
		createHash("sha256")
			.update(JSON.stringify({ lockfiles, versions, node: process.versions.node, ...selection }))
			.digest("hex");
	// The same shape on both sides, so only the selection version can tell them apart.
	expect(mutationInstallation(checkout)).toBe(identity({ selectionVersion: mutationSelectionVersion }));
	expect(mutationInstallation(checkout)).not.toBe(identity({}));
});
