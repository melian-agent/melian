import * as childProcess from "node:child_process";
import { ChildProcess, spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ancestorInstalls,
	inside,
	MutationEnumeration,
	MutationEnumerationError,
	TypeScriptMutationAdapter,
} from "../src/mutation-enumeration.ts";
import { commit, createRepository, gitIn, removeRepository, writeFiles } from "./fixtures/repo.ts";

vi.mock("node:module", async (original) => {
	const actual = await original<typeof nodeModule>();
	return { ...actual, createRequire: vi.fn(actual.createRequire) };
});
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof childProcess>();
	return { ...actual, execFile: vi.fn(actual.execFile), spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof nodeFs>();
	return { ...actual, realpath: vi.fn(actual.realpath) };
});
vi.mock("node:path", async (original) => {
	const actual = await original<typeof nodePath>();
	return { ...actual, relative: vi.fn(actual.relative) };
});

let repo: string;
let base: string;
let head: string;
beforeEach(() => {
	repo = createRepository();
	base = commit(repo, {
		"stryker.config.json": JSON.stringify({ mutator: { excludedMutations: ["StringLiteral"] } }),
		"src/value.ts": "export const value = (n: number) => n > 0;\n",
	});
	head = commit(repo, {
		"stryker.config.json": JSON.stringify({ mutator: { excludedMutations: ["BooleanLiteral"] } }),
		"src/value.ts": "export const value = (n: number) => n >= 0;\nexport const text = 'hello';\n",
		"src/comment.ts": "// Stryker disable all: Ignored because of excludedMutations\nexport const comment = true;\n",
		"src/value.test.ts": "throw new Error('tests must not run');\n",
		"src/throws.mjs": "throw new Error('source must not run');\nexport const flag = true;\n",
		"babel.config.cjs": "throw new Error('Babel config must not run');\n",
		"src/.babelrc.cjs": "throw new Error('nested Babel config must not run');\n",
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(nodeModule.createRequire).mockReset();
	vi.mocked(childProcess.execFile).mockReset();
	vi.mocked(childProcess.spawnSync).mockReset();
	vi.mocked(nodePath.relative).mockReset();
	vi.mocked(nodeFs.realpath).mockReset();
	vi.unstubAllGlobals();
	removeRepository(repo);
});

describe("mutation enumeration", { timeout: 60_000 }, () => {
	it("sets aside mixed unsupported source and accepts documentation and data extensions", async () => {
		const mixed = commit(repo, { "src/other.scala": "source\n" });
		expect(
			(await (await MutationEnumeration.open(repo, `${base}..${mixed}`)).list()).toJSON().unmutated,
		).toContainEqual({ file: "src/other.scala", reason: "no mutation adapter handles this language" });
		const extensions = [
			"md",
			"markdown",
			"txt",
			"rst",
			"adoc",
			"json",
			"yaml",
			"yml",
			"toml",
			"xml",
			"csv",
			"tsv",
			"lock",
			"map",
			"svg",
			"png",
			"jpg",
			"jpeg",
			"gif",
			"webp",
			"ico",
			"pdf",
			"snap",
			"tgz",
			"zip",
			"gz",
			"sum",
		];
		const docs = commit(repo, {
			...Object.fromEntries(extensions.map((extension) => [`data/value.${extension}`, "data\n"])),
			"data/v1.0/LICENSE": "terms\n",
			".npmrc": "save-exact=true\n",
			"data/file.name.": "data\n",
		});
		expect((await (await MutationEnumeration.open(repo, `${mixed}..${docs}`)).list()).toJSON().mutants).toEqual([]);
		const hidden = commit(repo, { "src/.hidden.scala": "source\n" });
		await expect((await MutationEnumeration.open(repo, `${docs}..${hidden}`)).list()).rejects.toMatchObject({
			code: "unsupported",
		});
	});
	it.each(["tool.scala", "src/code.md.scala"])("does not hide unsupported source at %s", async (file) => {
		const next = commit(repo, { [file]: "source\n" });
		await expect((await MutationEnumeration.open(repo, `${head}..${next}`)).list()).rejects.toMatchObject({
			code: "unsupported",
		});
	});

	it("changes installation identity with lockfiles, platform and architecture", async () => {
		const enumeration = await MutationEnumeration.open(repo, `${base}..${head}`);
		const original = (await enumeration.list()).toJSON().installation;
		for (const property of ["platform", "arch"] as const) {
			const realProcess = process;
			vi.stubGlobal(
				"process",
				new Proxy(realProcess, {
					get: (target, name) => (name === property ? "other-installation" : Reflect.get(target, name)),
				}),
			);
			expect((await enumeration.list()).toJSON().installation).not.toBe(original);
			vi.unstubAllGlobals();
		}
		writeFiles(repo, { "package-lock.json": "different install" });
		expect((await enumeration.list()).toJSON().installation).not.toBe(original);
	});
	it("bounds its own CLI enumeration and returns the committed identity", () => {
		const cli = fileURLToPath(new URL("../../cli/bin/melian.js", import.meta.url));
		const result = spawnSync(process.execPath, [cli, "mutants", "list", `${base}..${head}`, "--all", "--json"], {
			cwd: repo,
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(result.status, result.stderr || result.error?.message).toBe(0);
		const inventory = JSON.parse(result.stdout);
		expect(inventory.range).toEqual({ base, head });
		expect(inventory.mutants.some((row: { file: string }) => row.file === "src/value.ts")).toBe(true);
	});
	it("declares a switch adapter that needs no head build and exposes typed failures", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		expect(adapter.applies).toBe("switch");
		expect(adapter.enumerationRequiresBuild).toBe(false);
		const error = new MutationEnumerationError("unsupported", "missing language");
		expect({ name: error.name, code: error.code, message: error.message }).toEqual({
			name: "MutationEnumerationError",
			code: "unsupported",
			message: "missing language",
		});
	});

	it.each([
		"{",
		"null",
		'{"mutator":{"excludedMutations":"BooleanLiteral"}}',
		'{"mutator":{"excludedMutations":[1]}}',
		'{"mutator":{"excludedMutations":["StringLiteral",1]}}',
	])("refuses malformed mutation policy: %s", async (config) => {
		const policy = commit(repo, { "stryker.config.json": config });
		await expect(
			(
				await MutationEnumeration.open(repo, `${base}..${head}`, { policy: { kind: "revision", commit: policy } })
			).list(),
		).rejects.toMatchObject({ code: "policy" });
	});
	it("reads committed changed lines with base policy and never runs head configuration or code", {
		timeout: 10_000,
	}, async () => {
		writeFiles(repo, { "src/value.ts": "broken working tree!", "stryker.config.json": "broken working tree!" });
		const enumeration = await MutationEnumeration.open(repo, `${base}..${head}`);
		const inventory = (await enumeration.list({ all: true })).toJSON();
		expect(inventory.melianMutants).toBe(2);
		expect(inventory).toStrictEqual(JSON.parse(JSON.stringify(inventory)));
		if (inventory.melianMutants !== 2) throw new Error("expected version 2");
		expect(inventory.range).toEqual({ base, head });
		expect(inventory.omitted).toBe(0);
		expect(inventory.total).toBe(inventory.mutants.length);
		expect(inventory.adapters).toEqual([
			{ name: "typescript", version: "1", toolVersion: "10.0.0", source: "melian" },
		]);
		expect(inventory.installation).toMatch(/^[a-f0-9]{64}$/);
		expect(
			inventory.mutants.find((row) => row.file === "src/value.ts" && row.mutatorName === "StringLiteral"),
		).toMatchObject({ status: "ignored", ignoredBy: "config" });
		expect(
			inventory.mutants.find((row) => row.file === "src/comment.ts" && row.mutatorName === "BooleanLiteral"),
		).toMatchObject({ status: "ignored", ignoredBy: "comment" });
		expect(
			inventory.mutants.find((row) => row.file === "src/throws.mjs" && row.mutatorName === "BooleanLiteral"),
		).toMatchObject({ status: "generated" });
		expect(inventory.mutants.filter((row) => row.file.endsWith(".test.ts"))).toEqual([]);
		expect(inventory.mutants.find((row) => row.file === "src/comment.ts")?.statusReason).toEqual(expect.any(String));
		expect(inventory.mutants.every((row) => row.id.length === 64)).toBe(true);
	});

	it("bounds output exactly and --all retains every row", async () => {
		const enumeration = await MutationEnumeration.open(repo, `${base}..${head}`);
		const full = (await enumeration.list({ all: true })).toJSON();
		for (const limit of [0, full.total - 1, full.total, full.total + 1]) {
			const result = (await enumeration.list({ limit })).toJSON();
			expect(result.mutants).toEqual(full.mutants.slice(0, limit));
			expect(result.omitted).toBe(Math.max(0, full.total - limit));
		}
		await expect(enumeration.list({ limit: -1 })).rejects.toThrow("limit");
		const empty = (await (await MutationEnumeration.open(repo, `${head}..${head}`)).list()).toJSON();
		expect(empty.mutants).toEqual([]);
		expect(empty.total).toBe(0);
	});

	it("reports unsupported changed production languages and never follows a source symlink", async () => {
		await symlink("/etc/passwd", join(repo, "src/link.ts"));
		gitIn(repo, "add", "src/link.ts");
		gitIn(repo, "commit", "-qm", "symlink");
		const result = (await (await MutationEnumeration.open(repo, `${base}..HEAD`)).list()).toJSON();
		expect(result.unmutated).toContainEqual({
			file: "src/link.ts",
			reason: "the head entry is symlink; only regular files are mutated",
		});
		const rubyBase = commit(repo, { "src/a.rb": "a = 1\n" });
		const rubyHead = commit(repo, { "src/a.rb": "a = 2\n" });
		await expect((await MutationEnumeration.open(repo, `${rubyBase}..${rubyHead}`)).list()).rejects.toThrow(
			"no mutation adapter",
		);
	});

	it("cleans scratch on parser failure and accepts a missing policy config", async () => {
		const bad = commit(repo, { "src/bad.ts": "export const = ;" });
		const before = new Set(await readdir(tmpdir()));
		await expect((await MutationEnumeration.open(repo, `${base}..${bad}`)).list()).rejects.toThrow();
		expect(
			(await readdir(tmpdir())).filter(
				(name) => name.startsWith(`melian-enumerate-${process.pid}-`) && !before.has(name),
			),
		).toEqual([]);
		const configless = commit(repo, {}, ["stryker.config.json", "src/bad.ts"]);
		const next = commit(repo, { "src/flag.ts": "export const flag = false;\n" });
		expect((await (await MutationEnumeration.open(repo, `${configless}..${next}`)).list()).toJSON().total).toBe(1);
	});

	it("selects an installed checkout instrumenter and otherwise Melian's pinned copy", async () => {
		const fallback = await TypeScriptMutationAdapter.open(repo);
		expect(fallback.source).toBe("melian");
		writeFiles(repo, {
			"node_modules/.keep": "",
			"node_modules/@stryker-mutator/instrumenter/package.json": JSON.stringify({
				name: "@stryker-mutator/instrumenter",
				version: "10.0.0",
				type: "module",
				main: "index.js",
			}),
			"node_modules/@stryker-mutator/instrumenter/index.js": "throw new Error('selection does not execute');",
		});
		const installed = await TypeScriptMutationAdapter.open(repo);
		expect(installed.source).toBe("checkout");
		expect(installed.identity).toEqual({ ...fallback.identity, source: "checkout" });
		gitIn(repo, "add", "-f", "node_modules/.keep");
		gitIn(repo, "commit", "-qm", "tracked install");
		expect((await TypeScriptMutationAdapter.open(repo)).source).toBe("melian");
		await rm(join(repo, "node_modules/@stryker-mutator"), { recursive: true });
		expect(await readFile(join(repo, "node_modules/.keep"), "utf8")).toBe("");
	});
	it.each(["repository", "index"])(
		"ignores a foreign Git %s when rejecting tracked install code",
		async (redirect) => {
			const marker = join(repo, "executed");
			const instrumenter = nodeModule.createRequire(import.meta.url).resolve("@stryker-mutator/instrumenter");
			writeFiles(repo, {
				"node_modules/@stryker-mutator/instrumenter/package.json": JSON.stringify({
					name: "@stryker-mutator/instrumenter",
					version: "10.0.0",
					type: "module",
					main: "index.js",
				}),
				"node_modules/@stryker-mutator/instrumenter/index.js": `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'tracked instrumenter executed'); export {Instrumenter} from ${JSON.stringify(pathToFileURL(instrumenter).href)};`,
			});
			gitIn(repo, "add", "-f", "node_modules");
			gitIn(repo, "commit", "-qm", "tracked instrumenter");
			const foreign = createRepository();
			try {
				commit(foreign, { "README.md": "clean repository\n" });
				if (redirect === "repository") {
					vi.stubEnv("GIT_DIR", join(foreign, ".git"));
					vi.stubEnv("GIT_WORK_TREE", foreign);
				} else {
					vi.stubEnv("GIT_INDEX_FILE", join(foreign, ".git/index"));
				}
				const adapter = await TypeScriptMutationAdapter.open(repo);
				expect(
					await adapter.enumerate([{ name: "src/a.ts", content: "export const a=true;", ranges: [[1, 1]] }], []),
				).not.toEqual([]);
				expect(await readdir(repo)).not.toContain("executed");
				expect(adapter.source).toBe("melian");
			} finally {
				removeRepository(foreign);
			}
		},
	);
	it("refuses parent and workspace-linked instrumenters without executing tracked code", async () => {
		const packageJson = JSON.stringify({
			name: "@stryker-mutator/instrumenter",
			version: "10.0.0",
			type: "module",
			main: "index.js",
		});
		const marker = join(repo, "executed");
		const attack = `export class Instrumenter {}
import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('head code executed');`;
		commit(repo, { "packages/fake/package.json": packageJson, "packages/fake/index.js": attack });
		writeFiles(repo, { "node_modules/@stryker-mutator/.keep": "" });
		await symlink(join(repo, "packages/fake"), join(repo, "node_modules/@stryker-mutator/instrumenter"));
		await (await MutationEnumeration.open(repo, `${base}..${head}`)).list();
		expect((await TypeScriptMutationAdapter.open(repo)).source).toBe("melian");
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
		const nested = join(repo, "nested");
		await mkdir(nested);
		gitIn(nested, "init", "-q");
		expect((await TypeScriptMutationAdapter.open(nested)).source).toBe("melian");
	});
	it.each(["scala", "hs", "ex", "sh"])(
		"refuses an unsupported .%s source instead of reporting an empty success",
		async (extension) => {
			const start = commit(repo, { [`src/code.${extension}`]: "before\n" });
			const finish = commit(repo, { [`src/code.${extension}`]: "after\n" });
			await expect((await MutationEnumeration.open(repo, `${start}..${finish}`)).list()).rejects.toMatchObject({
				code: "unsupported",
			});
		},
	);
	it("does not need an adapter for deletion-only or unchanged unsupported source", async () => {
		const start = commit(repo, { "src/a.rb": "first\nsecond\n" });
		const deletion = commit(repo, { "src/a.rb": "second\n" });
		expect((await (await MutationEnumeration.open(repo, `${start}..${deletion}`)).list()).toJSON().mutants).toEqual(
			[],
		);
		const removed = commit(repo, {}, ["src/a.rb"]);
		expect((await (await MutationEnumeration.open(repo, `${deletion}..${removed}`)).list()).toJSON().mutants).toEqual(
			[],
		);
	});
	it("refuses an extensionless executable but permits uppercase documentation", async () => {
		writeFiles(repo, { "bin/tool": "#!/bin/sh\necho hi\n", "README.md": "manual\n" });
		await chmod(join(repo, "bin/tool"), 0o755);
		const executable = commit(repo, {});
		await expect((await MutationEnumeration.open(repo, `${head}..${executable}`)).list()).rejects.toMatchObject({
			code: "unsupported",
		});
		const docs = commit(repo, { "README.MD": "docs\n" });
		expect((await (await MutationEnumeration.open(repo, `${executable}..${docs}`)).list()).toJSON().mutants).toEqual(
			[],
		);
	});
	it.each([
		["a workspace dependency", "dependencies"],
		["optional workspace dependencies", "optionalDependencies"],
		["workspace peer dependencies", "peerDependencies"],
	])("refuses %s of an otherwise local instrumenter", async (_description, kind) => {
		const marker = join(repo, "executed");
		commit(repo, {
			"packages/dependency/package.json": JSON.stringify({
				name: "head-dependency",
				version: "1.0.0",
				main: "index.js",
				type: "module",
			}),
			"packages/dependency/index.js": `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`,
		});
		writeFiles(repo, {
			"node_modules/@stryker-mutator/instrumenter/package.json": JSON.stringify({
				name: "@stryker-mutator/instrumenter",
				version: "10.0.0",
				main: "index.js",
				type: "module",
				[kind]: { "head-dependency": "1.0.0" },
			}),
			"node_modules/@stryker-mutator/instrumenter/index.js": `import 'head-dependency'; export {Instrumenter} from ${JSON.stringify(pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("@stryker-mutator/instrumenter")).href)};`,
		});
		await symlink(join(repo, "packages/dependency"), join(repo, "node_modules/head-dependency"));
		const inventory = (await (await MutationEnumeration.open(repo, `${base}..${head}`)).list()).toJSON();
		expect(inventory.mutants.length).toBeGreaterThan(0);
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await TypeScriptMutationAdapter.open(repo)).source).toBe("melian");
	});
	it("never relabels rejected tracked code as Melian's own and needs no tool for an empty range", async () => {
		commit(repo, {
			"packages/fake/package.json": JSON.stringify({
				name: "@stryker-mutator/instrumenter",
				version: "10.0.0",
				main: "index.js",
				type: "module",
			}),
			"packages/fake/index.js": "throw new Error('tracked fallback must not load');",
		});
		const require = nodeModule.createRequire(import.meta.url),
			resolve = require.resolve;
		require.resolve = Object.assign(
			(name: string, options?: { paths?: string[] }) =>
				name === "@stryker-mutator/instrumenter" ? join(repo, "packages/fake/index.js") : resolve(name, options),
			{ paths: resolve.paths },
		);
		vi.mocked(nodeModule.createRequire).mockReturnValue(require);
		await expect(TypeScriptMutationAdapter.open(repo)).rejects.toMatchObject({ code: "instrumenter" });
		expect((await (await MutationEnumeration.open(repo, `${head}..${head}`)).list()).toJSON().adapters).toEqual([]);
	});
	it("keeps executable mode attached to its own path in a mixed revision", async () => {
		writeFiles(repo, { "bin/tool": "#!/bin/sh\necho hi\n", LICENSE: "terms\n" });
		await chmod(join(repo, "bin/tool"), 0o755);
		const next = commit(repo, {});
		const inventory = (await (await MutationEnumeration.open(repo, `${base}..${next}`)).list()).toJSON();
		expect(inventory.unmutated.filter((row) => row.reason === "no mutation adapter handles this language")).toEqual([
			{ file: "bin/tool", reason: "no mutation adapter handles this language" },
		]);
	});
	it.each([{}, { mutator: {} }])("uses empty exclusions when policy omits a mutator: %j", async (config) => {
		const policy = commit(repo, { "stryker.config.json": JSON.stringify(config) });
		const inventory = (
			await (
				await MutationEnumeration.open(repo, `${base}..${head}`, { policy: { kind: "revision", commit: policy } })
			).list()
		).toJSON();
		expect(
			inventory.mutants.find((row) => row.file === "src/value.ts" && row.mutatorName === "StringLiteral")?.status,
		).toBe("generated");
	});
	it.each(["command", "spawn"])("refuses a failed git inspection: %s", async (failure) => {
		const directory = await mkdtemp(join(tmpdir(), "melian-git-failure-"));
		try {
			if (failure === "spawn") vi.stubEnv("PATH", directory);
			await expect(TypeScriptMutationAdapter.open(failure === "command" ? directory : repo)).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "instrumenter",
				message: "cannot establish whether git tracks the installed instrumenter",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("reports corrupt untracked installation metadata and skips corrupt tracked installs", async () => {
		writeFiles(repo, {
			"node_modules/@stryker-mutator/instrumenter/package.json": "{",
			"node_modules/@stryker-mutator/instrumenter/index.js": "export class Instrumenter {}",
		});
		await expect(TypeScriptMutationAdapter.open(repo)).rejects.toThrow();
		gitIn(repo, "add", "-f", "node_modules");
		gitIn(repo, "commit", "-qm", "tracked corrupt install");
		expect((await TypeScriptMutationAdapter.open(repo)).source).toBe("melian");
	});
	it.each([false, true])(
		"requires missing dependencies but permits absent optional and peer packages: %s",
		async (required) => {
			writeFiles(repo, {
				"node_modules/@stryker-mutator/instrumenter/package.json": JSON.stringify({
					name: "@stryker-mutator/instrumenter",
					version: "10.0.0",
					main: "index.js",
					type: "module",
					...(required
						? { dependencies: { missing: "1" } }
						: { optionalDependencies: { missing: "1", file: "1" }, peerDependencies: { peer: "1" } }),
				}),
				"node_modules/@stryker-mutator/instrumenter/index.js": "export class Instrumenter {}",
				"node_modules/file": "not a directory",
			});
			expect((await TypeScriptMutationAdapter.open(repo)).source).toBe(required ? "melian" : "checkout");
		},
	);
	it.each([
		["worker failed", "worker failed"],
		["", "exec failed"],
	])("preserves worker error detail and handles stdin closure: %s", async (stderr, reason) => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const input = new PassThrough();
		const child = new ChildProcess();
		Object.defineProperty(child, "stdin", { value: input });
		vi.spyOn(input, "end").mockImplementation(() => {
			input.emit("error", new Error("EPIPE"));
			return input;
		});
		vi.mocked(childProcess.execFile).mockImplementation((...args) => {
			const callback = args[args.length - 1] as (error: Error, stdout: string, stderr: string) => void;
			queueMicrotask(() => callback(new Error("exec failed"), "", stderr));
			return child;
		});
		await expect(
			adapter.enumerate([{ name: "src/a.ts", content: "export const a=true;", ranges: [[1, 1]] }], []),
		).rejects.toMatchObject({ code: "instrumenter", message: expect.stringContaining(reason) });
	});
	it("pins ancestor installs and refuses parent, sibling and cross-volume paths", () => {
		const root = nodePath.parse(repo).root;
		expect(ancestorInstalls(join(root, "a", "b", "entry.js"))).toEqual([
			join(root, "a", "b", "node_modules"),
			join(root, "a", "node_modules"),
			join(root, "node_modules"),
		]);
		expect(inside(repo, join(repo, "child"))).toBe(true);
		expect(inside(join(repo, "child"), repo)).toBe(false);
		expect(inside(repo, join(nodePath.dirname(repo), "sibling"))).toBe(false);
		vi.mocked(nodePath.relative).mockReturnValue(`${root}different-volume`);
		expect(inside(repo, join(repo, "child"))).toBe(false);
	});
	it("does not take Melian's fallback from an unrelated resolver path", async () => {
		const external = await mkdtemp(join(tmpdir(), "melian-resolver-"));
		try {
			writeFiles(external, {
				"package.json": JSON.stringify({
					name: "@stryker-mutator/instrumenter",
					version: "10.0.0",
					main: "index.js",
				}),
				"index.js": "export class Instrumenter {}",
			});
			const require = nodeModule.createRequire(import.meta.url),
				resolve = require.resolve;
			require.resolve = Object.assign(
				(name: string, options?: { paths?: string[] }) =>
					name === "@stryker-mutator/instrumenter"
						? join(external, "index.js")
						: name === "@stryker-mutator/instrumenter/package.json"
							? join(external, "package.json")
							: resolve(name, options),
				{ paths: resolve.paths },
			);
			vi.mocked(nodeModule.createRequire).mockReturnValue(require);
			await expect(TypeScriptMutationAdapter.open(repo)).rejects.toMatchObject({ code: "instrumenter" });
		} finally {
			await rm(external, { recursive: true, force: true });
		}
	});
	it("rejects a fallback entry inside a reviewed tree even when its manifest is outside it", async () => {
		const external = await mkdtemp(join(process.cwd(), "node_modules/melian-review-"));
		try {
			const nested = join(external, "repo");
			await mkdir(nested);
			gitIn(nested, "init", "-q");
			writeFiles(external, {
				"package.json": JSON.stringify({
					name: "@stryker-mutator/instrumenter",
					version: "10.0.0",
					main: "repo/index.js",
				}),
				"repo/index.js": "export class Instrumenter {}",
			});
			gitIn(nested, "add", "index.js");
			gitIn(nested, "commit", "-qm", "tracked entry");
			const require = nodeModule.createRequire(import.meta.url),
				resolve = require.resolve;
			require.resolve = Object.assign(
				(name: string, options?: { paths?: string[] }) =>
					name === "@stryker-mutator/instrumenter"
						? join(nested, "index.js")
						: name === "@stryker-mutator/instrumenter/package.json"
							? join(external, "package.json")
							: resolve(name, options),
				{ paths: resolve.paths },
			);
			vi.mocked(nodeModule.createRequire).mockReturnValue(require);
			await expect(TypeScriptMutationAdapter.open(nested)).rejects.toMatchObject({ code: "instrumenter" });
		} finally {
			await rm(external, { recursive: true, force: true });
		}
	});
	it("ends a missing-manifest walk at the filesystem root", { timeout: 5000 }, async () => {
		writeFiles(repo, { "node_modules/@stryker-mutator/instrumenter/index.js": "export class Instrumenter {}" });
		await expect(TypeScriptMutationAdapter.open(repo)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["manifest", "dependency"])(
		"preserves permission failures while inspecting %s metadata",
		(kind) => {
			const packageRoot = join(repo, "node_modules/@stryker-mutator/instrumenter");
			writeFiles(repo, {
				"node_modules/@stryker-mutator/instrumenter/package.json": JSON.stringify({
					name: "@stryker-mutator/instrumenter",
					version: "10.0.0",
					main: "index.js",
					type: "module",
					...(kind === "dependency" ? { dependencies: { closed: "1.0.0" } } : {}),
				}),
				"node_modules/@stryker-mutator/instrumenter/index.js": "export class Instrumenter {}",
				"node_modules/closed/package.json": JSON.stringify({ name: "closed", version: "1.0.0" }),
			});
			const target = kind === "manifest" ? join(packageRoot, "package.json") : join(repo, "node_modules/closed");
			const driver = `import assert from 'node:assert/strict';
import {chmodSync} from 'node:fs';
import {createRequire} from 'node:module';
import {TypeScriptMutationAdapter} from ${JSON.stringify(new URL("../src/mutation-enumeration.ts", import.meta.url).href)};
const require=createRequire(${JSON.stringify(join(repo, "package.json"))});
require.resolve('@stryker-mutator/instrumenter');
chmodSync(${JSON.stringify(target)},0);
try { await assert.rejects(TypeScriptMutationAdapter.open(${JSON.stringify(repo)}),{code:'EACCES'}); }
finally { chmodSync(${JSON.stringify(target)},0o755); }
`;
			writeFiles(repo, { "permission-probe.mjs": driver });
			const result = spawnSync(
				process.execPath,
				["--conditions=@melian-agent/source", join(repo, "permission-probe.mjs")],
				{ cwd: repo, encoding: "utf8", timeout: 10_000 },
			);
			chmodSync(target, 0o755);
			expect(result.status, result.stderr || result.error?.message).toBe(0);
		},
	);
	it("does not invent search directories when a peer has no package resolution paths", async () => {
		writeFiles(repo, {
			"node_modules/@stryker-mutator/instrumenter/package.json": JSON.stringify({
				name: "@stryker-mutator/instrumenter",
				version: "10.0.0",
				main: "index.js",
				peerDependencies: { fs: "*" },
			}),
			"node_modules/@stryker-mutator/instrumenter/index.js": "export class Instrumenter {}",
		});
		const original = vi.mocked(nodeFs.realpath).getMockImplementation()!;
		vi.mocked(nodeFs.realpath).mockImplementation((file, options) => {
			expect(nodePath.isAbsolute(String(file))).toBe(true);
			return original(file, options);
		});
		expect((await TypeScriptMutationAdapter.open(repo)).source).toBe("checkout");
	});
	it("reports unsupported binary and non-UTF-8 source while ignoring their deletions", async () => {
		const binary = commit(repo, { "src/opaque.scala": "\0binary" });
		await expect((await MutationEnumeration.open(repo, `${head}..${binary}`)).list()).rejects.toMatchObject({
			code: "unsupported",
		});
		const removed = commit(repo, {}, ["src/opaque.scala"]);
		expect((await (await MutationEnumeration.open(repo, `${binary}..${removed}`)).list()).toJSON().mutants).toEqual(
			[],
		);
		writeFiles(repo, { "blob.txt": "source\n" });
		const blob = gitIn(repo, "hash-object", "-w", "blob.txt");
		childProcess.execFileSync("git", ["update-index", "--add", "--index-info"], {
			cwd: repo,
			input: Buffer.concat([Buffer.from(`100644 ${blob}\tsrc/caf`), Buffer.from([0xe9]), Buffer.from(".scala\n")]),
		});
		gitIn(repo, "commit", "-qm", "non UTF8 source");
		await expect((await MutationEnumeration.open(repo, `${removed}..HEAD`)).list()).rejects.toMatchObject({
			code: "unsupported",
		});
	});
});
