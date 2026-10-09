import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { backgroundContext, createNodeExecutionEnv } from "@melian-agent/pipeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MutationScratch, mutationHousekeeping } from "../src/mutation-scratch.ts";
import { Run } from "../src/static.ts";
import { unconfinedSandbox } from "./fixtures/sandbox.ts";

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
	fs.rmSync(directory, { recursive: true, force: true });
});

function files(): MutationScratch {
	const run = new Run(
		{
			env: createNodeExecutionEnv(directory),
			repoRoot: directory,
			commit: "a".repeat(40),
			tool: "mutation",
			settings: { enabled: true, timeout: 60, severity: {}, maxLines: 1 },
		},
		backgroundContext,
	);
	return MutationScratch.open(run, scratch, unconfinedSandbox, []);
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
						...overrides,
					}
				: path,
		process: {
			platform,
			argv: ["node", JSON.stringify([scratch, target, operation, "replacement"])],
			stdout: {
				write: (text: string) => {
					output += text;
				},
			},
		},
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
			tool: "mutation",
			settings: { enabled: true, timeout: 60, severity: {}, maxLines: 1 },
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
	expect(response).toEqual({ ok: true });
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
	expect(response).toEqual({ ok: true });
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
	expect(fs.existsSync(scratch)).toBe(false);
	expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("host data");
});
