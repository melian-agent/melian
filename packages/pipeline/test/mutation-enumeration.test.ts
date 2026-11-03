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
import * as core from "@melian-agent/core";
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
	return { ...actual, realpath: vi.fn(actual.realpath), writeFile: vi.fn(actual.writeFile) };
});
vi.mock("node:path", async (original) => {
	const actual = await original<typeof nodePath>();
	return { ...actual, relative: vi.fn(actual.relative) };
});
vi.mock("@melian-agent/core", async (original) => {
	const actual = await original<typeof core>();
	return { ...actual, openSource: vi.fn(actual.openSource) };
});

function workerReply(
	reply: (
		input: string,
		options: childProcess.ExecFileOptions,
		argv: readonly string[],
	) => { stdout: string; error?: childProcess.ExecFileException; stderr?: string },
): void {
	vi.mocked(childProcess.execFile).mockImplementation((...args) => {
		const callback = args[3] as (
			error: childProcess.ExecFileException | null,
			stdout: string,
			stderr: string,
		) => void;
		const input = new PassThrough();
		const chunks: Buffer[] = [];
		input.on("data", (chunk: Buffer) => chunks.push(chunk));
		input.on("finish", () => {
			try {
				const result = reply(
					Buffer.concat(chunks).toString("utf8"),
					args[2] as childProcess.ExecFileOptions,
					args[1] as string[],
				);
				queueMicrotask(() => callback(result.error ?? null, result.stdout, result.stderr ?? ""));
			} catch (error) {
				queueMicrotask(() => callback(error as Error, "", "test fake request mismatch"));
			}
		});
		const child = new ChildProcess();
		Object.defineProperty(child, "stdin", { value: input });
		return child;
	});
}

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
	vi.mocked(nodeFs.writeFile).mockReset();
	vi.mocked(core.openSource).mockReset();
	vi.unstubAllGlobals();
	removeRepository(repo);
});

describe("mutation enumeration", { timeout: 60_000 }, () => {
	it.each([
		["bun.lockb", "\0before", "\0after", "-\t-"],
		["bun.lock", "before\n", "after\n", "1\t1"],
	])("ignores a Bun dependency-only change: %s", async (file, before, after, numstat) => {
		const start = commit(repo, { "package.json": '{"dependencies":{}}\n', [file]: before });
		const finish = commit(repo, {
			"package.json": '{"dependencies":{"example":"1.0.0"}}\n',
			[file]: after,
		});
		expect(gitIn(repo, "diff", "--name-only", start, finish)).toBe(`${file}\npackage.json`);
		expect(gitIn(repo, "diff", "--numstat", start, finish, "--", file)).toBe(`${numstat}\t${file}`);
		expect((await (await MutationEnumeration.open(repo, `${start}..${finish}`)).list()).toJSON()).toEqual({
			melianMutants: 2,
			range: { base: start, head: finish },
			installation: expect.stringMatching(/^[a-f0-9]{64}$/),
			mutants: [],
			total: 0,
			omitted: 0,
			unmutated: [],
			adapters: [],
		});
	});

	it.each([
		[200, 0],
		[201, 1],
	])("retains the default 200 rows from exactly %s real mutants with %s omitted", async (total, omitted) => {
		const start = commit(repo, {
			"stryker.config.json": JSON.stringify({ mutator: { excludedMutations: ["StringLiteral"] } }),
		});
		const finish = commit(repo, {
			"src/flags.ts": Array.from({ length: total }, (_, index) => `export const flag${index} = true;\n`).join(""),
		});
		const enumeration = await MutationEnumeration.open(repo, `${start}..${finish}`);
		const full = (await enumeration.list({ all: true })).toJSON();
		expect(full.total).toBe(total);
		expect(full.omitted).toBe(0);
		expect(full.mutants).toHaveLength(total);
		expect(full.mutants.map(({ mutatorName, status }) => ({ mutatorName, status }))).toEqual(
			Array.from({ length: total }, () => ({ mutatorName: "BooleanLiteral", status: "generated" })),
		);
		expect(full.range).toEqual({ base: start, head: finish });
		expect(full.adapters).toHaveLength(1);
		expect(full.unmutated).toEqual([]);
		const result = (await enumeration.list()).toJSON();
		expect(result.mutants).toHaveLength(200);
		expect(result).toEqual({ ...full, mutants: full.mutants.slice(0, 200), omitted });
	});

	it("accepts maximum one-based coordinates including a zero-width origin row and an empty reason", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const row = {
			fileName: "src/a.ts",
			location: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
			mutatorName: "BooleanLiteral",
			replacement: "",
			statusReason: "",
		};
		workerReply((input) => {
			expect(JSON.parse(input)).toEqual({ files: [], excludedMutations: [], limit: 1 });
			return { stdout: JSON.stringify({ total: 1, mutants: [row] }) };
		});
		expect(await adapter.enumerate([], [], 1)).toEqual({
			total: 1,
			mutants: [
				{
					file: "src/a.ts",
					line: 1,
					column: 0,
					endLine: 1,
					endColumn: 0,
					mutatorName: "BooleanLiteral",
					replacement: "",
					status: "generated",
					statusReason: "",
				},
			],
		});
	});
	it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
		"refuses malformed worker batch count %s at limit zero",
		async (total) => {
			const adapter = await TypeScriptMutationAdapter.open(repo);
			workerReply((input) => {
				expect(JSON.parse(input)).toEqual({ files: [], excludedMutations: [], limit: 0 });
				return { stdout: JSON.stringify({ total, mutants: [] }) };
			});
			await expect(adapter.enumerate([], [], 0)).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "instrumenter",
				message: expect.stringContaining("invalid"),
			});
		},
	);
	it.each([
		[121000, 120000],
		[121001, 120000],
		[Number.MAX_SAFE_INTEGER, 120000],
		[1001, 1],
	])("bounds caller deadline %s to timeout %s", async (deadline, timeout) => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		vi.spyOn(performance, "now").mockReturnValue(1000);
		let observedTimeout: number | undefined;
		workerReply((input, options) => {
			expect(JSON.parse(input)).toEqual({
				files: [
					{
						name: "src/a.ts",
						content: "export const a = true;",
						mutate: [{ start: { line: 0, column: 0 }, end: { line: 0, column: Number.MAX_SAFE_INTEGER } }],
					},
				],
				excludedMutations: ["StringLiteral"],
				limit: 0,
			});
			observedTimeout = options.timeout;
			return { stdout: '{"total":0,"mutants":[]}' };
		});
		expect(
			await adapter.enumerate(
				[{ name: "src/a.ts", content: "export const a = true;", ranges: [[1, 1]] }],
				["StringLiteral"],
				0,
				deadline,
			),
		).toEqual({ total: 0, mutants: [] });
		expect(observedTimeout).toBe(timeout);
	});
	it.each([Number.NaN, Number.POSITIVE_INFINITY])(
		"refuses a non-finite caller deadline %s before input work",
		async (deadline) => {
			const adapter = await TypeScriptMutationAdapter.open(repo);
			await expect(adapter.enumerate([], [], 0, deadline)).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "limit",
				message: expect.stringContaining("deadline"),
			});
			expect(nodeFs.writeFile).not.toHaveBeenCalled();
			expect(childProcess.execFile).not.toHaveBeenCalled();
		},
	);
	it("refuses an expired empty selection after policy input", async () => {
		const enumeration = await MutationEnumeration.open(repo, `${head}..${head}`);
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const open = vi.mocked(core.openSource).getMockImplementation()!;
		let calls = 0;
		vi.mocked(core.openSource).mockImplementation(async (root, selected) => {
			const source = await open(root, selected);
			if (++calls === 2) now = 120000;
			return source;
		});
		await expect(enumeration.list({ limit: 0 })).rejects.toMatchObject({
			name: "MutationEnumerationError",
			code: "limit",
			message: expect.stringContaining("deadline"),
		});
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});
	it("accepts a multiline row whose columns reset", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const row = {
			fileName: "src/a.ts",
			location: { start: { line: 0, column: 4 }, end: { line: 1, column: 0 } },
			mutatorName: "BooleanLiteral",
			replacement: "false",
		};
		workerReply((input) => {
			expect(JSON.parse(input)).toEqual({ files: [], excludedMutations: [], limit: 1 });
			return { stdout: JSON.stringify({ total: 1, mutants: [row] }) };
		});
		expect(await adapter.enumerate([], [], 1)).toEqual({
			total: 1,
			mutants: [
				{
					file: "src/a.ts",
					line: 1,
					column: 4,
					endLine: 2,
					endColumn: 0,
					mutatorName: "BooleanLiteral",
					replacement: "false",
					status: "generated",
				},
			],
		});
	});
	it("uses non-negative bounded string offsets while encoding", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const content = `/*${"x".repeat(16380)}*/`;
		const slice = String.prototype.slice;
		vi.spyOn(String.prototype, "slice").mockImplementation(function (this: string, start, end) {
			if (this === content || this === "src/a.ts") {
				expect(start).toBeGreaterThanOrEqual(0);
				expect(end! - start!).toBeGreaterThan(0);
				expect(end! - start!).toBeLessThanOrEqual(16384);
			}
			return slice.call(this, start, end);
		});
		workerReply((input) => {
			expect(JSON.parse(input)).toEqual({
				files: [{ name: "src/a.ts", content, mutate: [] }],
				excludedMutations: [],
				limit: 0,
			});
			return { stdout: '{"mutants":[],"total":0}' };
		});
		expect(await adapter.enumerate([{ name: "src/a.ts", content, ranges: [] }], [], 0)).toEqual({
			mutants: [],
			total: 0,
		});
	});
	it.each(["missing", "unreadable", "ordinary"])("preserves a committed source %s failure", async (kind) => {
		const next = commit(repo, { "src/read.ts": "export const flag = true;" });
		const enumeration = await MutationEnumeration.open(repo, `${head}..${next}`);
		const open = vi.mocked(core.openSource).getMockImplementation()!;
		const error =
			kind === "unreadable"
				? new core.SourceError("unreadable", "src/read.ts", "source unavailable")
				: new Error("ordinary source failure");
		vi.mocked(core.openSource).mockImplementation(async (root, selected) => {
			const source = await open(root, selected);
			return new Proxy(source, {
				get(target, key, receiver) {
					if (key !== "readText") return Reflect.get(target, key, receiver);
					return async (path: string, max: number) => {
						if (path !== "src/read.ts") return target.readText(path, max);
						expect(max).toBe(16 * 1024 * 1024);
						if (kind === "missing") return undefined;
						throw error;
					};
				},
			});
		});
		if (kind === "missing")
			await expect(enumeration.list()).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "instrumenter",
				message: "committed source src/read.ts is missing",
			});
		else await expect(enumeration.list()).rejects.toBe(error);
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});
	it("bounds decoded expansion against remaining aggregate before retention", async () => {
		const contents = Array.from({ length: 4 }, (_, i) => `export const v${i} = true;`);
		const names = [...contents.map((_, i) => `src/partial${i}.ts`), "src/partial4.ts"];
		const next = commit(repo, Object.fromEntries(names.map((name, i) => [name, contents[i] ?? "// bytes"])));
		const opened = vi.spyOn(TypeScriptMutationAdapter, "open");
		const enumeration = await MutationEnumeration.open(repo, `${head}..${next}`);
		const open = vi.mocked(core.openSource).getMockImplementation()!;
		const byteLength = Buffer.byteLength;
		vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
			const index = contents.indexOf(value as string);
			return encoding === "utf8" && index >= 0 ? (index === 3 ? 15 : 16) * 1024 * 1024 : byteLength(value, encoding);
		});
		vi.mocked(core.openSource).mockImplementation(async (root, selected) => {
			const source = await open(root, selected);
			return new Proxy(source, {
				get(target, key, receiver) {
					if (key !== "readText") return Reflect.get(target, key, receiver);
					return async (path: string, max: number) => {
						const index = names.indexOf(path);
						if (index < 0) return target.readText(path, max);
						expect(max).toBe((index === 4 ? 1 : 16) * 1024 * 1024);
						return index === 4 ? Buffer.alloc(1024 * 1024, 0xff).toString("utf8") : contents[index];
					};
				},
			});
		});
		await expect(enumeration.list({ limit: 0 })).rejects.toMatchObject({
			name: "MutationEnumerationError",
			code: "limit",
			message: expect.stringContaining("aggregate"),
		});
		expect(childProcess.execFile).not.toHaveBeenCalled();
		expect(opened).not.toHaveBeenCalled();
	});
	it("keeps a real valid C0 comment through encoded input and preserves its row", { timeout: 5000 }, async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const content = `/*${String.fromCharCode(1, 2, 3, 31)}*/export const flag = true;`;
		expect(await adapter.enumerate([{ name: "src/a.ts", content, ranges: [[1, 1]] }], [], 1)).toEqual({
			total: 1,
			mutants: [
				{
					file: "src/a.ts",
					line: 1,
					column: 28,
					endLine: 1,
					endColumn: 32,
					mutatorName: "BooleanLiteral",
					replacement: "false",
					status: "generated",
				},
			],
		});
	});
	it("preserves a quoted surrogate pair crossing an encoding chunk boundary", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const name = `${"x".repeat(16383)}${String.fromCodePoint(0x10348)}.ts`;
		workerReply((input) => {
			expect(JSON.parse(input)).toEqual({
				files: [
					{
						name,
						content: "// é",
						mutate: [
							{ start: { line: 0, column: 0 }, end: { line: 1, column: Number.MAX_SAFE_INTEGER } },
							{ start: { line: 3, column: 0 }, end: { line: 4, column: Number.MAX_SAFE_INTEGER } },
						],
					},
				],
				excludedMutations: ["one", "two"],
				limit: 0,
			});
			return { stdout: '{"total":0,"mutants":[]}' };
		});
		expect(
			await adapter.enumerate(
				[
					{
						name,
						content: "// é",
						ranges: [
							[1, 2],
							[4, 5],
						],
					},
				],
				["one", "two"],
				0,
			),
		).toEqual({ mutants: [], total: 0 });
	});
	it.each([0, Number.MAX_SAFE_INTEGER])(
		"accepts the exact safe full-count boundary %s with no retained rows",
		async (total) => {
			const adapter = await TypeScriptMutationAdapter.open(repo);
			workerReply((input) => {
				expect(JSON.parse(input)).toEqual({ files: [], excludedMutations: [], limit: 0 });
				return { stdout: JSON.stringify({ mutants: [], total }) };
			});
			expect(await adapter.enumerate([], [], 0)).toEqual({ mutants: [], total });
		},
	);
	it("accepts maximum one-based coordinates and rejects excess retained valid rows", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const row = {
			fileName: "src/a.ts",
			location: {
				start: { line: Number.MAX_SAFE_INTEGER - 1, column: Number.MAX_SAFE_INTEGER },
				end: { line: Number.MAX_SAFE_INTEGER - 1, column: Number.MAX_SAFE_INTEGER },
			},
			mutatorName: "BooleanLiteral",
			replacement: "false",
			status: "Ignored",
			statusReason: "excludedMutations forged by a comment",
		};
		workerReply((input) => {
			const { limit } = JSON.parse(input);
			expect(JSON.parse(input)).toEqual({ files: [], excludedMutations: [], limit });
			return { stdout: JSON.stringify({ mutants: [row], total: 1 }) };
		});
		expect(await adapter.enumerate([], [], 1)).toEqual({
			total: 1,
			mutants: [
				{
					file: "src/a.ts",
					line: Number.MAX_SAFE_INTEGER,
					column: Number.MAX_SAFE_INTEGER,
					endLine: Number.MAX_SAFE_INTEGER,
					endColumn: Number.MAX_SAFE_INTEGER,
					mutatorName: "BooleanLiteral",
					replacement: "false",
					status: "ignored",
					ignoredBy: "comment",
					statusReason: row.statusReason,
				},
			],
		});
		await expect(adapter.enumerate([], [], 0)).rejects.toMatchObject({
			name: "MutationEnumerationError",
			code: "instrumenter",
			message: expect.stringContaining("invalid"),
		});
	});
	it("shares the deadline begun before committed input work", async () => {
		const next = commit(repo, { "src/clock.ts": "export const flag = true;" });
		const enumeration = await MutationEnumeration.open(repo, `${head}..${next}`);
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const reads: string[] = [];
		const open = vi.mocked(core.openSource).getMockImplementation()!;
		vi.mocked(core.openSource).mockImplementation(async (root, selected) => {
			const source = await open(root, selected);
			now = 120000;
			return new Proxy(source, {
				get(target, key, receiver) {
					if (key !== "readText") return Reflect.get(target, key, receiver);
					return async (path: string, max: number) => {
						reads.push(path);
						return target.readText(path, max);
					};
				},
			});
		});
		await expect(enumeration.list({ limit: 0 })).rejects.toMatchObject({
			name: "MutationEnumerationError",
			code: "limit",
			message: expect.stringContaining("deadline"),
		});
		expect(childProcess.execFile).not.toHaveBeenCalled();
		expect(reads).toEqual([]);
	});
	it.each([0, 1])("checks committed blob size before reading at sixteen MiB plus %s", async (over) => {
		const content = `/*${"a".repeat(16 * 1024 * 1024 - 4 + over)}*/`;
		const next = commit(repo, { "src/blob.ts": content });
		const enumeration = await MutationEnumeration.open(repo, `${head}..${next}`);
		if (over)
			await expect(enumeration.list({ limit: 0 })).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "limit",
				message: "enumeration source exceeds 16 MiB per file",
			});
		else {
			const { mutants, total, omitted, unmutated } = (await enumeration.list({ limit: 0 })).toJSON();
			expect({ mutants, total, omitted, unmutated }).toEqual({ mutants: [], total: 0, omitted: 0, unmutated: [] });
		}
	});
	it("refuses retained UTF8 expansion of a bounded invalid-UTF8 Git blob", async () => {
		await nodeFs.writeFile(
			join(repo, "src/invalid.ts"),
			Buffer.concat([Buffer.from("/*"), Buffer.alloc(6 * 1024 * 1024, 0xff), Buffer.from("*/")]),
		);
		const next = commit(repo, {});
		const opened = vi.spyOn(TypeScriptMutationAdapter, "open");
		const enumeration = await MutationEnumeration.open(repo, `${head}..${next}`);
		await expect(enumeration.list({ limit: 0 })).rejects.toMatchObject({
			name: "MutationEnumerationError",
			code: "limit",
			message: "enumeration source exceeds 16 MiB per file",
		});
		expect(childProcess.execFile).not.toHaveBeenCalled();
		expect(opened).not.toHaveBeenCalled();
	});
	it.each([0, 1])("asks committed authority for the remaining aggregate before reading: %s", async (over) => {
		const contents = Array.from({ length: 4 + over }, (_, i) => `export const v${i} = true;`);
		const names = contents.map((_, i) => `src/aggregate${i}.ts`);
		const next = commit(repo, Object.fromEntries(names.map((name, i) => [name, contents[i]!])));
		const enumeration = await MutationEnumeration.open(repo, `${head}..${next}`);
		const open = vi.mocked(core.openSource).getMockImplementation()!;
		const requests: [string, number][] = [];
		vi.mocked(core.openSource).mockImplementation(async (root, selected) => {
			const source = await open(root, selected);
			return new Proxy(source, {
				get(target, key, receiver) {
					if (key !== "readText") return Reflect.get(target, key, receiver);
					return async (path: string, max: number) => {
						const index = names.indexOf(path);
						if (index < 0) return target.readText(path, max);
						requests.push([path, max]);
						if (index === 4 && max < Buffer.byteLength(contents[index]!))
							throw new core.SourceError("tooLarge", path, "source exceeds remaining aggregate", { size: 1 });
						return contents[index];
					};
				},
			});
		});
		const byteLength = Buffer.byteLength;
		vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) =>
			encoding === "utf8" && contents.includes(value as string) ? 16 * 1024 * 1024 : byteLength(value, encoding),
		);
		workerReply((input) => {
			expect(JSON.parse(input)).toEqual({
				files: names.map((name, i) => ({
					name,
					content: contents[i],
					mutate: [{ start: { line: 0, column: 0 }, end: { line: 0, column: Number.MAX_SAFE_INTEGER } }],
				})),
				excludedMutations: ["BooleanLiteral"],
				limit: 0,
			});
			return { stdout: JSON.stringify({ total: names.length, mutants: [] }) };
		});
		if (over) {
			await expect(enumeration.list({ limit: 0 })).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "limit",
				message: expect.stringContaining("aggregate"),
			});
			expect(childProcess.execFile).not.toHaveBeenCalled();
		} else {
			const { total, mutants, omitted } = (await enumeration.list({ limit: 0 })).toJSON();
			expect({ total, mutants, omitted }).toEqual({ total: 4, mutants: [], omitted: 4 });
		}
		expect(requests).toEqual(names.map((name, i) => [name, i < 4 ? 16 * 1024 * 1024 : 0]));
	});
	it.each([
		[0, 1],
		[1, 1],
		[0, 2],
		[1, 2],
	])(
		"checks a real worker response at sixty-four MiB plus %s across %s rows and counts at zero",
		async (over, rowCount) => {
			const rows = Array.from({ length: rowCount! }, (_, i) => ({
				fileName: "src/a.ts",
				location: { start: { line: 0, column: i }, end: { line: 0, column: i + 1 } },
				mutatorName: "StringLiteral",
				replacement: "",
			}));
			const size = 64 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ total: rowCount, mutants: rows })) + over!;
			const sizes = rows.map((_, i) => Math.floor(size / rows.length) + (i === 0 ? size % rows.length : 0));
			writeFiles(repo, {
				"node_modules/@stryker-mutator/instrumenter/package.json": JSON.stringify({
					name: "@stryker-mutator/instrumenter",
					version: "10.0.0",
					type: "module",
					main: "index.js",
				}),
				"node_modules/@stryker-mutator/instrumenter/index.js": `export class Instrumenter { async instrument(files,options) { if(JSON.stringify(files)!==JSON.stringify([{name:"src/a.ts",content:"true;",mutate:[]}]) || options.plugins!==null || options.ignorers.length!==0 || options.excludedMutations.length!==0) throw Error("unexpected request"); const rows=${JSON.stringify(rows)},sizes=${JSON.stringify(sizes)};return {mutants:rows.map((row,i)=>({...row,replacement:"x".repeat(sizes[i])}))}; } }`,
			});
			const adapter = await TypeScriptMutationAdapter.open(repo);
			const files = [{ name: "src/a.ts", content: "true;", ranges: [] }];
			expect(await adapter.enumerate(files, [], 0)).toEqual({ total: rowCount, mutants: [] });
			if (over)
				await expect(adapter.enumerate(files, [], rowCount).then(() => "accepted")).rejects.toMatchObject({
					name: "MutationEnumerationError",
					code: "limit",
					message: expect.stringContaining("response"),
				});
			else
				expect(await adapter.enumerate(files, [], rowCount)).toEqual({
					total: rowCount,
					mutants: rows.map((_row, i) => ({
						file: "src/a.ts",
						line: 1,
						column: i,
						endLine: 1,
						endColumn: i + 1,
						mutatorName: "StringLiteral",
						replacement: "x".repeat(sizes[i]!),
						status: "generated",
					})),
				});
		},
	);
	it.each([
		{ fileName: "" },
		{ fileName: " " },
		{ fileName: 1 },
		{ mutatorName: " " },
		{ replacement: null },
		{ status: "Survived" },
		{ statusReason: 1 },
		{ location: null },
		{ location: { start: { line: 0, column: 0 }, end: { line: Number.MAX_SAFE_INTEGER, column: 1 } } },
		{ location: { start: { line: 0, column: 0 }, end: { line: 1, column: -1 } } },
		{ location: { start: { line: 0.5, column: 0 }, end: { line: 1, column: 1 } } },
		{ location: { start: { line: 0, column: 0.5 }, end: { line: 0, column: 1 } } },
		{ location: { start: { line: 0, column: 0 }, end: { line: 0.5, column: 1 } } },
		{ location: { start: { line: 0, column: 0 }, end: { line: 0, column: 1.5 } } },
		...[-1, 0.5, Number.MAX_SAFE_INTEGER, Number.NaN].map((line) => ({
			location: { start: { line, column: 0 }, end: { line: 0, column: 1 } },
		})),
		{ location: { start: { line: 0, column: -1 }, end: { line: 0, column: 1 } } },
		{ location: { start: { line: 1, column: 0 }, end: { line: 0, column: 1 } } },
		{ location: { start: { line: 0, column: 2 }, end: { line: 0, column: 1 } } },
	])("refuses a malformed worker row independently: %j", async (change) => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const row = {
			fileName: "src/a.ts",
			location: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
			mutatorName: "BooleanLiteral",
			replacement: "false",
			...change,
		};
		workerReply((input) => {
			expect(JSON.parse(input)).toEqual({ files: [], excludedMutations: [], limit: 1 });
			return { stdout: JSON.stringify({ total: 1, mutants: [row] }) };
		});
		await expect(adapter.enumerate([], [], 1)).rejects.toMatchObject({
			name: "MutationEnumerationError",
			code: "instrumenter",
			message: expect.stringContaining("invalid"),
		});
	});
	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"refuses invalid adapter row limit %s before spawning",
		async (limit) => {
			const adapter = await TypeScriptMutationAdapter.open(repo);
			await expect(adapter.enumerate([], [], limit)).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "limit",
				message: "limit must be a non-negative safe integer",
			});
			expect(childProcess.execFile).not.toHaveBeenCalled();
		},
	);
	it.each([0, 0.5, 1, 1.75])("passes only a positive integer remaining deadline: %s", async (remaining) => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		vi.spyOn(performance, "now")
			.mockReturnValueOnce(0)
			.mockReturnValue(120000 - remaining);
		workerReply((input, options, argv) => {
			expect(JSON.parse(input)).toEqual({ files: [], excludedMutations: [], limit: 0 });
			expect(options.timeout).toBe(1);
			expect(argv.slice(0, 2)).toEqual(["--max-old-space-size=512", "--input-type=module"]);
			return { stdout: '{"total":0,"mutants":[]}' };
		});
		if (remaining < 1) {
			await expect(adapter.enumerate([], [], 0)).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "limit",
				message: expect.stringContaining("deadline"),
			});
			expect(childProcess.execFile).not.toHaveBeenCalled();
			expect(nodeFs.writeFile).not.toHaveBeenCalled();
		} else expect(await adapter.enumerate([], [], 0)).toEqual({ mutants: [], total: 0 });
	});
	it("checks the deadline again after encoding the payload and removes scratch", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const stringify = JSON.stringify;
		vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
			if (value === "deadline-marker") now = 120000;
			return stringify(value, ...args);
		});
		const before = new Set(await readdir(tmpdir()));
		await expect(adapter.enumerate([], ["deadline-marker"], 0)).rejects.toMatchObject({
			name: "MutationEnumerationError",
			code: "limit",
			message: expect.stringContaining("deadline"),
		});
		expect(childProcess.execFile).not.toHaveBeenCalled();
		expect(
			(await readdir(tmpdir())).filter(
				(name) => name.startsWith(`melian-enumerate-${process.pid}-`) && !before.has(name),
			),
		).toEqual([]);
	});
	it.each([0, 1])("bounds direct decoded source bytes at sixteen MiB plus %s", async (over) => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const content = `/*${"é".repeat((16 * 1024 * 1024 - 4) / 2)}${"x".repeat(over)}*/`;
		workerReply((input) => {
			expect(JSON.parse(input)).toEqual({
				files: [{ name: "src/a.ts", content, mutate: [] }],
				excludedMutations: [],
				limit: 0,
			});
			return { stdout: '{"total":0,"mutants":[]}' };
		});
		const pending = adapter.enumerate([{ name: "src/a.ts", content, ranges: [] }], [], 0);
		if (over) {
			await expect(pending).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "limit",
				message: "enumeration source exceeds 16 MiB per file",
			});
			expect(childProcess.execFile).not.toHaveBeenCalled();
		} else expect(await pending).toEqual({ mutants: [], total: 0 });
	});
	it.each([0, 1])("bounds aggregate retained source independently at sixty-four MiB plus %s", async (over) => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const files = Array.from({ length: 5 }, (_, i) => ({
			name: `src/f${i}.ts`,
			content: `export const v${i} = true;`,
			ranges: [],
		}));
		const byteLength = Buffer.byteLength;
		vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
			const index = files.findIndex((file) => file.content === value);
			return index < 0 || encoding !== "utf8" ? byteLength(value, encoding) : index < 4 ? 16 * 1024 * 1024 : over;
		});
		workerReply((input) => {
			expect(JSON.parse(input)).toEqual({
				files: files.map(({ name, content }) => ({ name, content, mutate: [] })),
				excludedMutations: [],
				limit: 0,
			});
			return { stdout: '{"total":0,"mutants":[]}' };
		});
		const pending = adapter.enumerate(files, [], 0);
		if (over) {
			await expect(pending).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "limit",
				message: expect.stringContaining("aggregate"),
			});
			expect(childProcess.execFile).not.toHaveBeenCalled();
		} else expect(await pending).toEqual({ mutants: [], total: 0 });
	});
	it.each([0, 1])(
		"bounds encoded UTF8 payload including C0 comment escaping at sixty-four MiB plus %s",
		async (over) => {
			const adapter = await TypeScriptMutationAdapter.open(repo);
			const cap = 64 * 1024 * 1024;
			const name = "src/é.ts";
			const ranges: [number, number][] = [
				[1, 1],
				[3, 3],
			];
			const mutate = ranges.map(([first, last]) => ({
				start: { line: first - 1, column: 0 },
				end: { line: last - 1, column: Number.MAX_SAFE_INTEGER },
			}));
			const excludedMutations = ["StringLiteral", "BooleanLiteral"];
			const overhead = Buffer.byteLength(
				JSON.stringify({
					files: [{ name, content: "/**/", mutate }],
					excludedMutations,
					limit: 0,
				}),
			);
			const budget = cap - overhead;
			const content = `/*${"\u0001".repeat(Math.floor(budget / 6))}${"x".repeat((budget % 6) + over)}*/`;
			workerReply((input) => {
				expect(Buffer.byteLength(input)).toBe(cap);
				expect(JSON.parse(input)).toEqual({
					files: [{ name, content, mutate }],
					excludedMutations,
					limit: 0,
				});
				return { stdout: '{"total":0,"mutants":[]}' };
			});
			const pending = adapter.enumerate([{ name, content, ranges }], excludedMutations, 0);
			if (over) {
				await expect(pending).rejects.toMatchObject({
					name: "MutationEnumerationError",
					code: "limit",
					message: expect.stringContaining("payload"),
				});
				expect(childProcess.execFile).not.toHaveBeenCalled();
			} else expect(await pending).toEqual({ mutants: [], total: 0 });
		},
	);
	it.each([
		[
			"heap",
			{ signal: "SIGABRT", killed: false },
			"FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
			"limit",
			"heap",
		],
		["timeout", { signal: "SIGTERM", killed: true }, "", "limit", "deadline"],
		["machine response refusal", { code: 73 }, "", "limit", "response"],
		["other killed signal", { signal: "SIGKILL", killed: true }, "other signal", "instrumenter", "other signal"],
		[
			"heap text without abort",
			{ signal: "SIGTERM", killed: false },
			"heap limit from import",
			"instrumenter",
			"heap limit from import",
		],
		[
			"stdout text without overflow code",
			{ message: "stdout reported by import" },
			"",
			"instrumenter",
			"stdout reported by import",
		],
		[
			"stdout",
			{
				code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
				message: "stdout maxBuffer length exceeded",
				killed: true,
				signal: "SIGTERM",
			},
			"",
			"limit",
			"response",
		],
		[
			"stderr",
			{
				code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
				message: "stderr maxBuffer length exceeded",
				killed: true,
				signal: "SIGTERM",
			},
			"",
			"instrumenter",
			"stderr",
		],
		["abort", { signal: "SIGABRT", killed: false }, "syntax failed", "instrumenter", "syntax failed"],
		["term", { signal: "SIGTERM", killed: false }, "import failed", "instrumenter", "import failed"],
		["spoof", {}, "response too large\u001b", "instrumenter", "response too large\\u001b"],
	] as const)(
		"classifies worker %s without trusting stderr as a protocol status",
		{ timeout: 5000 },
		async (_name, fields, stderr, code, message) => {
			const adapter = await TypeScriptMutationAdapter.open(repo);
			workerReply((input) => {
				expect(JSON.parse(input)).toEqual({ files: [], excludedMutations: [], limit: 0 });
				return {
					stdout: "",
					error: Object.assign(new Error("worker failed"), fields) as childProcess.ExecFileException,
					stderr,
				};
			});
			await expect(adapter.enumerate([], [], 0)).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code,
				message: expect.stringContaining(message),
			});
		},
	);
	it.each([
		"{",
		"null",
		"[]",
		'{"total":-1,"mutants":[]}',
		'{"total":0.5,"mutants":[]}',
		'{"total":9007199254740992,"mutants":[]}',
		'{"total":0,"mutants":null}',
		'{"total":1,"mutants":[]}',
		'{"total":0,"mutants":[{}]}',
		'{"total":1,"mutants":[{}]}',
	])("refuses malformed worker batch %s", async (output) => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		workerReply((input) => {
			expect(JSON.parse(input)).toEqual({ files: [], excludedMutations: [], limit: 1 });
			return { stdout: output };
		});
		await expect(adapter.enumerate([], [], 1)).rejects.toMatchObject({
			name: "MutationEnumerationError",
			code: "instrumenter",
			message: expect.stringContaining("invalid"),
		});
	});
	it("counts all dense real mutants without serialising rows at limit zero", async () => {
		const identifier = `v${"x".repeat(8191)}`;
		const content = `export const value = ${Array(140).fill(identifier).join(" - ")};\n`;
		expect(Buffer.byteLength(content)).toBe(1_147_320);
		const next = commit(repo, { "src/dense.ts": content });
		const enumeration = await MutationEnumeration.open(repo, `${head}..${next}`);
		const result = (await enumeration.list({ limit: 0 })).toJSON();
		expect({
			mutants: result.mutants,
			total: result.total,
			omitted: result.omitted,
			unmutated: result.unmutated,
		}).toEqual({ mutants: [], total: 139, omitted: 139, unmutated: [] });
		const first = (await enumeration.list({ limit: 1 })).toJSON();
		expect(first.total).toBe(139);
		expect(first.omitted).toBe(138);
		expect(
			first.mutants.map(({ mutatorName, replacement, line, column, endLine, endColumn }) => ({
				mutatorName,
				replacement,
				line,
				column,
				endLine,
				endColumn,
			})),
		).toEqual([
			{
				mutatorName: "ArithmeticOperator",
				replacement: `${Array(139).fill(identifier).join(" - ")} + ${identifier}`,
				line: 1,
				column: 21,
				endLine: 1,
				endColumn: content.length - 2,
			},
		]);
		for (const options of [{}, { all: true }])
			await expect(enumeration.list(options)).rejects.toMatchObject({
				name: "MutationEnumerationError",
				code: "limit",
				message: expect.stringContaining("response"),
			});
	});
	it.each([
		["lone CR", "// a\r// z\n"],
		["CRLF with lone CR", "// a\r\r\n"],
		["Unicode comment", `// a${String.fromCharCode(0x2028)}// z\n`],
		["Unicode string", `const s = 'a${String.fromCharCode(0x2029)}';\n`],
	])("sets aside whole files with %s after a real committed read", async (_label, prefix) => {
		const earlier = commit(repo, { "src/lines.ts": `${prefix}const x = 1;\nexport const b = x - 1;\n` });
		const later = commit(repo, { "src/lines.ts": `${prefix}const x = 1;\nexport const b = x + 1;\n` });
		const result = (
			await (await MutationEnumeration.open(repo, `${earlier}..${later}`)).list({ all: true })
		).toJSON();
		expect(result.mutants).toEqual([]);
		expect({
			adapters: result.adapters,
			total: result.total,
			omitted: result.omitted,
			unmutated: result.unmutated,
		}).toEqual({
			adapters: [],
			total: 0,
			omitted: 0,
			unmutated: [
				{
					file: "src/lines.ts",
					reason: "Git and the parser count lone CR, U+2028 and U+2029 line breaks differently",
				},
			],
		});
	});
	it("refuses wrong-line rows when inserting a separator shifts unchanged mutable code", async () => {
		const earlier = commit(repo, { "src/lines.ts": "// a\nexport const x = y > 1;\nexport const b = x - 1;\n" });
		const later = commit(repo, { "src/lines.ts": "// a\r// z\nexport const x = y > 1;\nexport const b = x + 1;\n" });
		const result = (
			await (await MutationEnumeration.open(repo, `${earlier}..${later}`)).list({ all: true })
		).toJSON();
		expect(result.mutants).toEqual([]);
		expect(result.unmutated).toEqual([
			{
				file: "src/lines.ts",
				reason: "Git and the parser count lone CR, U+2028 and U+2029 line breaks differently",
			},
		]);
		expect(result.adapters).toEqual([]);
	});
	it("sets aside a separator-only change and enumerates only safe files in a mixed change", async () => {
		const earlier = commit(repo, { "src/lines.ts": "// a\nexport const x = y > 1;\n" });
		const later = commit(repo, {
			"src/lines.ts": "// a\r// z\nexport const x = y > 1;\n",
			"src/safe.ts": "export const flag = true;\n",
		});
		const result = (
			await (await MutationEnumeration.open(repo, `${earlier}..${later}`)).list({ all: true })
		).toJSON();
		expect(result.mutants.map(({ id: _id, ...row }) => row)).toEqual([
			{
				file: "src/safe.ts",
				line: 1,
				column: 20,
				endLine: 1,
				endColumn: 24,
				mutatorName: "BooleanLiteral",
				replacement: "false",
				status: "ignored",
				ignoredBy: "config",
				statusReason: 'Ignored because of excluded mutation "BooleanLiteral"',
			},
		]);
		expect(result.unmutated).toEqual([
			{
				file: "src/lines.ts",
				reason: "Git and the parser count lone CR, U+2028 and U+2029 line breaks differently",
			},
		]);
		expect(result.adapters).toHaveLength(1);
	});
	it.each(["\n", "\r\n"])("keeps twelve real mutants for a new four-Git-line %j control", async (eol) => {
		const content = Array.from({ length: 4 }, (_, i) => `export const v${i} = n === 1;`).join(eol) + eol;
		const later = commit(repo, { "src/four.ts": content });
		const safe = (await (await MutationEnumeration.open(repo, `${head}..${later}`)).list({ all: true })).toJSON();
		expect(safe.total).toBe(12);
		expect(safe.unmutated).toEqual([]);
		expect(safe.mutants.map(({ line }) => line)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
		const unsafe = commit(repo, { "src/four.ts": content.replace(";", ";\r// separator") });
		const result = (await (await MutationEnumeration.open(repo, `${head}..${unsafe}`)).list({ all: true })).toJSON();
		expect(result.mutants).toEqual([]);
		expect(result.unmutated).toEqual([
			{ file: "src/four.ts", reason: "Git and the parser count lone CR, U+2028 and U+2029 line breaks differently" },
		]);
		expect(result.adapters).toEqual([]);
	});
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
	it("keeps preloads and unrelated variables out of the enumeration worker", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const marker = join(repo, "preload-marker");
		const preload = join(repo, "preload.cjs");
		const sentinel = "parent-only-value";
		writeFiles(repo, {
			"preload.cjs": `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.MELIAN_ENUMERATION_SENTINEL);`,
		});
		vi.stubEnv("NODE_OPTIONS", `--require=${JSON.stringify(preload)}`);
		vi.stubEnv("MELIAN_ENUMERATION_SENTINEL", sentinel);
		try {
			const control = spawnSync(process.execPath, ["--eval", ""], {
				cwd: repo,
				encoding: "utf8",
				timeout: 10_000,
				env: {
					PATH: process.env.PATH,
					LANG: "C.UTF-8",
					NODE_OPTIONS: process.env.NODE_OPTIONS,
					MELIAN_ENUMERATION_SENTINEL: sentinel,
				},
			});
			expect(control.status, control.stderr || control.error?.message).toBe(0);
			expect(await readFile(marker, "utf8")).toBe(sentinel);
			await rm(marker);
			expect(
				(
					await adapter.enumerate(
						[{ name: "src/flag.ts", content: "export const flag = true;", ranges: [[1, 1]] }],
						[],
					)
				).mutants,
			).toEqual([
				{
					file: "src/flag.ts",
					line: 1,
					column: 20,
					endLine: 1,
					endColumn: 24,
					mutatorName: "BooleanLiteral",
					replacement: "false",
					status: "generated",
				},
			]);
			await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
			const calls = vi.mocked(childProcess.execFile).mock.calls;
			expect(calls).toHaveLength(1);
			const options = calls[0][2]!;
			expect(options.env).toEqual({ PATH: process.env.PATH, HOME: options.cwd, LANG: "C.UTF-8" });
			expect(options).toEqual({
				cwd: expect.any(String),
				maxBuffer: 64 * 1024 * 1024 + 1024,
				timeout: expect.any(Number),
				env: { PATH: process.env.PATH, HOME: options.cwd, LANG: "C.UTF-8" },
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("enumerates source larger than the stdin pipe buffer", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const content = `export const value = true;\n${"// padding\n".repeat(20_000)}`;
		expect((await adapter.enumerate([{ name: "src/large.ts", content, ranges: [[1, 1]] }], [])).mutants).toEqual([
			{
				file: "src/large.ts",
				line: 1,
				column: 21,
				endLine: 1,
				endColumn: 25,
				mutatorName: "BooleanLiteral",
				replacement: "false",
				status: "generated",
			},
		]);
	});
	it("preserves Unicode split across stdin chunks", async () => {
		const adapter = await TypeScriptMutationAdapter.open(repo);
		const exec = vi.mocked(childProcess.execFile).getMockImplementation()!;
		vi.mocked(childProcess.execFile).mockImplementation((...args) => {
			const parameters = args[1] as string[];
			parameters[parameters.length - 1] =
				`process.stdin.once('data', () => process.stderr.write('chunk received'));\n${parameters[parameters.length - 1]}`;
			const child = exec(...args);
			const end = child.stdin!.end.bind(child.stdin!);
			vi.spyOn(child.stdin!, "end").mockImplementation((...endArgs) => {
				const bytes = Buffer.from(endArgs[0] as string);
				const split = bytes.lastIndexOf(Buffer.from("é")) + 1;
				expect(bytes.subarray(split - 1, split + 1)).toEqual(Buffer.from("é"));
				// Wait for a worker read so the pipe cannot coalesce the split bytes.
				child.stderr!.once("data", () => end(bytes.subarray(split)));
				child.stdin!.write(bytes.subarray(0, split));
				return child.stdin!;
			});
			return child;
		});
		const mutants = await adapter.enumerate(
			[
				{
					name: "src/unicode.ts",
					content: "export const café = true; export const result = café + 1;\n",
					ranges: [[1, 1]],
				},
			],
			[],
		);
		expect(mutants.mutants.map((mutant) => mutant.replacement)).toEqual(["false", "café - 1"]);
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

	it.each([
		[".babelrc.js", "js"],
		[".babelrc.cjs", "jsx"],
		[".babelrc.mjs", "js"],
		[".babelrc", "js"],
		[".babelrc.json", "jsx"],
		["package.json", "js"],
		["scratch-parent/.babelrc.cjs", "js"],
	])("isolates tracked %s when JavaScript scratch is inside the repository (%s)", async (configFile, extension) => {
		const marker = join(repo, "babel-executed");
		const plugin = join(repo, "config-plugin.cjs");
		const common = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'head Babel config executed');`;
		let config = `${common} module.exports = {};`;
		if (configFile.endsWith(".mjs"))
			config = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'head Babel config executed'); export default {};`;
		if (configFile === ".babelrc" || configFile === ".babelrc.json") config = JSON.stringify({ plugins: [plugin] });
		if (configFile === "package.json") config = JSON.stringify({ babel: { plugins: [plugin] } });
		const policy = commit(repo, {
			"package.json": "{}",
			".gitignore": "scratch-parent/nested/\n",
			"stryker.config.json": JSON.stringify({ mutator: { excludedMutations: ["StringLiteral"] } }),
			"config-plugin.cjs": `${common} module.exports = () => ({visitor: {}});`,
			[configFile]: config,
		});
		const file = `src/javascript.${extension}`;
		const next = commit(repo, {
			[file]: `export const flag=true;${extension === "jsx" ? " export const view=<div />;" : ""}\n`,
		});
		const temporary = join(repo, "scratch-parent/nested");
		await mkdir(temporary, { recursive: true });
		vi.stubEnv("TMPDIR", temporary);
		const inventory = (await (await MutationEnumeration.open(repo, `${policy}..${next}`)).list()).toJSON();
		expect(inventory.mutants).toContainEqual(
			expect.objectContaining({ file, mutatorName: "BooleanLiteral", replacement: "false", status: "generated" }),
		);
		expect(await readdir(repo)).not.toContain("babel-executed");
		expect(await readdir(temporary)).toEqual([]);
	});

	it("cleans scratch and starts no parser when writing the Babel package boundary fails", async () => {
		const temporary = await mkdtemp(join(tmpdir(), "melian-boundary-failure-"));
		try {
			vi.stubEnv("TMPDIR", temporary);
			const adapter = await TypeScriptMutationAdapter.open(repo);
			vi.mocked(nodeFs.writeFile).mockImplementationOnce(async (file, data) => {
				expect(nodePath.basename(file as string)).toBe("package.json");
				expect(data).toBe("{}");
				throw Object.assign(new Error("boundary write denied"), { code: "EACCES" });
			});
			await expect(
				adapter.enumerate([{ name: "src/a.js", content: "export const a=true;", ranges: [[1, 1]] }], []),
			).rejects.toMatchObject({ code: "EACCES" });
			expect(childProcess.execFile).not.toHaveBeenCalled();
			expect(await readdir(temporary)).toEqual([]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
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
					(await adapter.enumerate([{ name: "src/a.ts", content: "export const a=true;", ranges: [[1, 1]] }], []))
						.mutants,
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
	it.each([false, true])("ignores an executable Python test (mixed production: %s)", async (mixed) => {
		writeFiles(repo, {
			"tests/test_api.py": "#!/usr/bin/env python3\nassert True\n",
			...(mixed ? { "src/added.ts": "export const added = (n: number) => n > 0;\n" } : {}),
		});
		await chmod(join(repo, "tests/test_api.py"), 0o755);
		const finish = commit(repo, {});
		const inventory = (await (await MutationEnumeration.open(repo, `${head}..${finish}`)).list()).toJSON();
		expect(inventory.unmutated).toEqual([]);
		expect(new Set(inventory.mutants.map((row) => row.file))).toEqual(new Set(mixed ? ["src/added.ts"] : []));
	});

	it("applies shared exclusions to executable fixtures, test names and generated directories", async () => {
		const excluded = [
			"test/runner.py",
			"__tests__/runner.py",
			"__mocks__/runner.py",
			"fixtures/runner",
			"goldens/runner.py",
			"dist/runner",
			"node_modules/runner",
			"packages/evals/verifier/runner",
			"src/helper.test.ts",
			"src/helper.spec.js",
			"src/types.d.ts",
		];
		writeFiles(repo, {
			...Object.fromEntries(excluded.map((file) => [file, "#!/bin/sh\necho test fixture\n"])),
			"src/added.ts": "export const added = (n: number) => n > 0;\n",
		});
		await Promise.all(excluded.map((file) => chmod(join(repo, file), 0o755)));
		gitIn(repo, "add", "-f", "--", ...excluded);
		const finish = commit(repo, {});
		const inventory = (await (await MutationEnumeration.open(repo, `${head}..${finish}`)).list()).toJSON();
		expect(inventory.unmutated).toEqual([]);
		expect(new Set(inventory.mutants.map((row) => row.file))).toEqual(new Set(["src/added.ts"]));
	});

	it("refuses a line-break-only extensionless production executable", async () => {
		writeFiles(repo, { "\n": "#!/bin/sh\necho production\n" });
		await chmod(join(repo, "\n"), 0o755);
		const finish = commit(repo, {});
		await expect((await MutationEnumeration.open(repo, `${head}..${finish}`)).list()).rejects.toMatchObject({
			code: "unsupported",
		});
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
