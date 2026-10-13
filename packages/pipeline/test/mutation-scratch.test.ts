import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as promiseFilesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { defaultConfig } from "@melian-agent/core";
import { backgroundContext, createNodeExecutionEnv } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MutationScratch, mutationHousekeeping } from "../src/mutation-scratch.ts";
import { Run } from "../src/static.ts";
import { unconfinedSandbox } from "./fixtures/sandbox.ts";

vi.mock("node:fs/promises", { spy: true });

let directory: string;
let scratch: string;
let outside: string;

beforeEach(() => {
	directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "melian-scratch-safety-")));
	scratch = path.join(directory, "scratch");
	outside = path.join(directory, "outside");
	fs.mkdirSync(path.join(scratch, "tree/.git/objects/info"), { recursive: true });
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "sentinel"), "host data");
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(directory, { recursive: true, force: true });
});

function files(sandbox: Parameters<typeof MutationScratch.open>[2] = unconfinedSandbox): MutationScratch {
	const run = new Run(
		{
			env: createNodeExecutionEnv(directory),
			repoRoot: directory,
			commit: "a".repeat(40),
			tool: "biome",
			settings: { ...defaultConfig.static.biome, timeout: 60 },
		},
		backgroundContext,
	);
	return MutationScratch.open(run, scratch, sandbox, []);
}

function probe(
	operation: string,
	target: string,
	platform = "darwin",
	overrides: Readonly<Record<string, unknown>> = {},
) {
	let descriptor = 0;
	const open = vi.fn((_path: string, _flags: number) => ++descriptor);
	const close = vi.fn((_descriptor: number) => {});
	const remove = vi.fn();
	const truncate = vi.fn();
	const write = vi.fn();
	let output = "";
	runInNewContext(mutationHousekeeping, {
		require: (name: string) =>
			name === "node:fs"
				? {
						...fs,
						openSync: open,
						closeSync: close,
						rmSync: remove,
						ftruncateSync: truncate,
						writeFileSync: write,
						fstatSync: () => ({ isFile: () => true }),
						readSync: () => 0,
						...overrides,
					}
				: path,
		process: {
			platform,
			argv: ["node", JSON.stringify([scratch, target, operation, "replacement", 64])],
			stdout: {
				write: (text: string) => {
					output += text;
				},
			},
		},
		Buffer,
	});
	return { open, close, remove, truncate, write, response: JSON.parse(output) as { ok?: boolean; error?: string } };
}

const components = ["", "tree", "tree/.git", "tree/.git/objects", "tree/.git/objects/info"];

it.each(components)("refuses a symlink at %s before writing, without changing host data", async (component) => {
	const swapped = path.join(scratch, component);
	fs.renameSync(swapped, `${swapped}.saved`);
	fs.symlinkSync(outside, swapped, "dir");
	const target = path.join(scratch, "tree/.git/objects/info/sentinel");
	await expect(files().write(target, "overwritten")).rejects.toThrow(`symlink ${swapped}`);
	expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("host data");
	expect(fs.readdirSync(outside)).toEqual(["sentinel"]);
});

it.each(components)("refuses a symlink at %s before recursive removal with fake delete controls", (component) => {
	const swapped = path.join(scratch, component);
	fs.renameSync(swapped, `${swapped}.saved`);
	fs.symlinkSync(outside, swapped, "dir");
	const { remove, response } = probe("remove", path.join(scratch, "tree/.git/objects/info"));
	expect(response).toEqual({ error: expect.stringContaining(`symlink ${swapped}`) });
	expect(remove).not.toHaveBeenCalled();
	expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("host data");
});

it.each(["..", "../outside/sentinel", "../../elsewhere"])(
	"rejects %s before deleting with fake controls",
	(relative) => {
		const { response, remove } = probe("remove", path.resolve(scratch, relative));
		expect(response.error).toContain("outside scratch");
		expect(remove).not.toHaveBeenCalled();
	},
);

it("refuses a broken symlink before deletion", () => {
	const target = path.join(scratch, "broken");
	fs.symlinkSync(path.join(outside, "missing"), target);
	const { response, remove } = probe("remove", target);
	expect(response.error).toContain(`symlink ${target}`);
	expect(remove).not.toHaveBeenCalled();
});

it.each(["execution error", "nonzero exit"])("records the refused path after %s", async (kind) => {
	const env = createNodeExecutionEnv(directory);
	vi.spyOn(env, "exec").mockImplementation(async (_command, options, context) => {
		await options?.onOutput?.("refused target", context);
		return kind === "execution error"
			? { ok: false, error: Object.assign(new Error("denied"), { code: "spawn_error" as const }) }
			: { ok: true, value: { exitCode: 1 } };
	});
	const run = new Run(
		{
			env,
			repoRoot: directory,
			commit: "a".repeat(40),
			tool: "biome",
			settings: { ...defaultConfig.static.biome, timeout: 60 },
		},
		backgroundContext,
	);
	const target = path.join(scratch, "target");
	await expect(MutationScratch.open(run, scratch, unconfinedSandbox, []).write(target, "value")).rejects.toThrow(
		`scratch operation refused ${target}: refused target`,
	);
});

it("refuses a non-directory component before deletion", () => {
	fs.writeFileSync(path.join(scratch, "plain"), "file");
	const { response, remove } = probe("remove", path.join(scratch, "plain/child"));
	expect(response.error).toContain(`non-directory ${path.join(scratch, "plain")}`);
	expect(remove).not.toHaveBeenCalled();
});

it("uses Darwin's atomic no-follow-any flag without the incompatible no-follow flag", () => {
	const target = path.join(scratch, "tree/file");
	const { open, close, write, truncate, response } = probe("write", target);
	expect(response).toEqual({ ok: true, missing: false });
	expect(open).toHaveBeenCalledExactlyOnceWith(
		target,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | 0x20000000,
	);
	expect(truncate).toHaveBeenCalledExactlyOnceWith(1, 0);
	expect(write).toHaveBeenCalledExactlyOnceWith(1, "replacement");
	expect(close).toHaveBeenCalledExactlyOnceWith(1);
});

it("opens every Linux directory through its pinned descriptor and closes all handles", () => {
	const target = path.join(scratch, "tree/file");
	const { open, close, response } = probe("write", target, "linux");
	expect(response).toEqual({ ok: true, missing: false });
	const components = target.split("/").filter(Boolean);
	expect(open.mock.calls).toEqual([
		["/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY],
		...components
			.slice(0, -1)
			.map((part, index) => [
				`/proc/self/fd/${index + 1}/${part}`,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
			]),
		[
			`/proc/self/fd/${components.length}/${components.at(-1)}`,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
		],
	]);
	expect(close.mock.calls.map(([fd]) => fd)).toEqual([
		...components.map((_, index) => index + 1),
		components.length + 1,
	]);
});

it("closes a rejected non-file without truncating or writing it", () => {
	const { response, close, write, truncate } = probe("write", path.join(scratch, "tree/file"), "darwin", {
		fstatSync: () => fs.statSync(outside),
	});
	expect(response.error).toContain("non-file");
	expect(close).toHaveBeenCalledExactlyOnceWith(1);
	expect(truncate).not.toHaveBeenCalled();
	expect(write).not.toHaveBeenCalled();
});

it("removes existing and missing files with fake controls and refuses unknown operations", () => {
	const existing = path.join(scratch, "tree/.git");
	expect(probe("remove", existing).remove).toHaveBeenCalledExactlyOnceWith(existing, { recursive: true, force: true });
	const missing = path.join(scratch, "missing");
	expect(probe("remove", missing).remove).toHaveBeenCalledExactlyOnceWith(missing, { recursive: true, force: true });
	expect(probe("unknown", existing).response.error).toContain("unknown operation");
});

it("writes and replaces a regular file, removes it, and closes the scratch directory", async () => {
	const operations = files();
	const target = path.join(scratch, "tree/file");
	await operations.write(target, "first");
	await operations.write(target, "new");
	expect(fs.readFileSync(target, "utf8")).toBe("new");
	await operations.remove(target);
	expect(fs.existsSync(target)).toBe(false);
	await operations.close();
	await operations.remove(path.join(scratch, "base/tree"));
	await operations.close();
	expect(fs.existsSync(scratch)).toBe(false);
	expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("host data");
});

it.each(["log", "report"])("refuses a symlinked %s without reading host contents", async (name) => {
	const target = path.join(scratch, name);
	fs.symlinkSync(path.join(outside, "sentinel"), target);
	await expect(files().read(target, 64)).rejects.toThrow(`non-file ${target}`);
	const result = probe("read", target);
	expect(result.response.error).toContain(`non-file ${target}`);
	expect(result.open).not.toHaveBeenCalled();
	expect(JSON.stringify(result.response)).not.toContain("host data");
});
it("reads only bounded regular output and treats a missing leaf as absent", async () => {
	const target = path.join(scratch, "output");
	expect(await files().read(target, 64)).toBeUndefined();
	expect(await files().read(path.join(scratch, "absent/parent/output"), 64)).toBeUndefined();
	fs.writeFileSync(target, "x".repeat(63));
	expect(await files().read(target, 64)).toBe("x".repeat(63));
	fs.writeFileSync(target, "x".repeat(64));
	await expect(files().read(target, 64)).rejects.toMatchObject({ code: "outputTooLarge" });
	fs.writeFileSync(target, "x".repeat(65));
	await expect(files().read(target, 64)).rejects.toMatchObject({ code: "outputTooLarge" });
});
it("rechecks an opened output descriptor with fake read controls", () => {
	const target = path.join(scratch, "output");
	fs.writeFileSync(target, "text");
	const read = vi.fn();
	const result = probe("read", target, "darwin", { fstatSync: () => fs.statSync(outside), readSync: read });
	expect(result.response.error).toContain(`non-file ${target}`);
	expect(read).not.toHaveBeenCalled();
	expect(result.close).toHaveBeenCalledOnce();
});

it("launches housekeeping from a trusted directory rather than a head-written scratch path", async () => {
	const command = vi.spyOn(unconfinedSandbox, "command");
	await files().write(path.join(scratch, "tree/file"), "text");
	expect(command).toHaveBeenCalledExactlyOnceWith(
		expect.any(String),
		expect.objectContaining({ worktree: "/", scratch }),
		"",
		undefined,
	);
});

it("keeps missing cleanup harmless but refuses other filesystem failures", async () => {
	const env = createNodeExecutionEnv(directory);
	const run = new Run(
		{
			env,
			repoRoot: directory,
			commit: "a".repeat(40),
			tool: "biome",
			settings: { ...defaultConfig.static.biome, timeout: 60 },
		},
		backgroundContext,
	);
	const operations = MutationScratch.open(run, scratch, unconfinedSandbox, []);
	const execute = vi.spyOn(env, "exec");
	await operations.remove(path.join(scratch, "base/tree"));
	expect(execute).not.toHaveBeenCalled();
	await expect(operations.close()).resolves.toBeUndefined();
	fs.writeFileSync(scratch, "not a directory");
	await expect(operations.close()).rejects.toThrow();
});

it("does not treat a denied cleanup lookup as an absent path", async () => {
	const env = createNodeExecutionEnv(directory);
	vi.spyOn(env, "fileInfo").mockResolvedValue({
		ok: false,
		error: Object.assign(new Error("denied"), { code: "permission_denied" as const }),
	});
	const execute = vi.spyOn(env, "exec").mockRejectedValue(new Error("attempted confined removal"));
	const run = new Run(
		{
			env,
			repoRoot: directory,
			commit: "a".repeat(40),
			tool: "biome",
			settings: { ...defaultConfig.static.biome, timeout: 60 },
		},
		backgroundContext,
	);
	await expect(
		MutationScratch.open(run, scratch, unconfinedSandbox, []).remove(path.join(scratch, "tree")),
	).rejects.toThrow("attempted confined removal");
	expect(execute).toHaveBeenCalledOnce();
});

it.each(["EACCES", "ENOTEMPTY"])(
	"fails with worktreeFailed, naming scratch, when it cannot be removed (%s)",
	async (code) => {
		vi.spyOn(promiseFilesystem, "rmdir").mockRejectedValueOnce(Object.assign(new Error("rmdir failed"), { code }));
		await expect(files().close()).rejects.toMatchObject({
			code: "worktreeFailed",
			message: `${scratch} could not be removed: ${code}`,
		});
	},
);

it("takes a scratch directory that is already gone as removed", async () => {
	vi.spyOn(promiseFilesystem, "rmdir").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
	await expect(files().close()).resolves.toBeUndefined();
});

// With no sandbox the script runs on the host, and its own guards are the whole defence.
it.each(components)("refuses to read through a symlink at %s, on the host and in a sandbox", async (component) => {
	const swapped = path.join(scratch, component);
	fs.renameSync(swapped, `${swapped}.saved`);
	fs.symlinkSync(outside, swapped, "dir");
	fs.mkdirSync(path.join(outside, "tree/.git/objects/info"), { recursive: true });
	fs.writeFileSync(path.join(outside, "tree/.git/objects/info/sentinel"), "host data");
	const target = path.join(scratch, component === "" ? "sentinel" : "tree/.git/objects/info/sentinel");
	for (const sandbox of [undefined, unconfinedSandbox]) {
		const failure = await files(sandbox)
			.read(target, 64)
			.catch((error: Error) => error.message);
		expect(failure).toContain(`symlink ${swapped}`);
		expect(failure).not.toContain("host data");
	}
});

it("reads, writes, and removes on the host when there is no sandbox, with a scratch HOME and nothing inherited", async () => {
	vi.stubEnv("MELIAN_TEST_SECRET", "hunter2");
	const env = createNodeExecutionEnv(directory);
	const execute = vi.spyOn(env, "exec");
	const run = new Run(
		{ env, repoRoot: directory, commit: "a".repeat(40), tool: "biome", settings: defaultConfig.static.biome },
		backgroundContext,
	);
	const operations = MutationScratch.open(run, scratch, undefined, []);
	const target = path.join(scratch, "tree/file");
	await operations.write(target, "text");
	expect(await operations.read(target, 64)).toBe("text");
	await operations.remove(target);
	expect(fs.existsSync(target)).toBe(false);
	for (const [command, options] of execute.mock.calls) {
		expect(command.startsWith(`'${process.execPath}' -e '`)).toBe(true);
		expect(options).toMatchObject({ inheritEnv: false, env: { HOME: scratch, TMPDIR: scratch }, timeout: 60 });
		expect(Object.keys(options!.env!)).toEqual(["HOME", "TMPDIR"]);
	}
	expect(execute).toHaveBeenCalledTimes(3);
	vi.unstubAllEnvs();
});

it.each(["link", "fifo", "directory"])(
	"refuses to read a %s on the host, naming it and reading nothing",
	async (kind) => {
		const target = path.join(scratch, "output");
		if (kind === "link") fs.symlinkSync(path.join(outside, "sentinel"), target);
		else if (kind === "directory") fs.mkdirSync(target);
		else execFileSync("/usr/bin/mkfifo", [target]);
		const failure = await files(undefined)
			.read(target, 64)
			.catch((error: Error) => error.message);
		expect(failure).toContain(`non-file ${target}`);
		expect(failure).not.toContain("host data");
	},
);
