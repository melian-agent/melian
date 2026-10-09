import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function cleanup(fault = process.env.MELIAN_CLEANUP_FAULT ?? "") {
	const source = readFileSync(new URL("../src/static.ts", import.meta.url), "utf8");
	let code = source.slice(source.indexOf("async function removeWorktree("));
	if (fault) {
		const [before, after] = JSON.parse(fault) as [string, string];
		expect(code.split(before)).toHaveLength(2);
		code = code.replace(before, after);
	}
	const remove = vi.fn();
	const close = vi.fn();
	const open = vi.fn(() => ({ close }));
	const detect = vi.fn((): object | undefined => ({}));
	const shell = vi.fn(async () => ({ code: 1 }));
	const fileInfo = vi.fn(async (_path: string) => ({ ok: true, value: { kind: "file" } }));
	const run = {
		input: { env: { remove, fileInfo }, settings: {}, repoRoot: "/repo" },
		context: {},
		fail: (_code: string, message: string) => new Error(message),
		shell,
		worktreeCommand: vi.fn(async () => ({ code: 0 })),
		readOutput: async () => "worktree /tmp/melian-static-old/tree\0locked melian-static mutation pid 120\0\0",
		mutationScratch: undefined as { close: typeof close } | undefined,
	};
	class FakeRun {
		worktreeCommand = run.worktreeCommand;
		git = (command: string) => command;
	}
	const functions = runInNewContext(`${stripTypeScriptTypes(code)}\n({ removeWorktree, removeStaleWorktrees })`, {
		Run: FakeRun,
		backgroundContext: {},
		Sandbox: { detect },
		MutationScratch: { open },
		posix,
		quote: (value: string) => value,
		git: () => "list",
	}) as {
		removeWorktree(value: typeof run, scratch: string, mutation?: boolean): Promise<void>;
		removeStaleWorktrees(value: typeof run, scratch: string): Promise<void>;
	};
	return { ...functions, run, remove, close, open, detect, shell, fileInfo };
}

it("keeps recursive mutation cleanup confined and refuses a missing sandbox", async () => {
	const c = cleanup();
	await c.removeWorktree(c.run, "/scratch", true);
	expect(c.open).toHaveBeenCalled();
	expect(c.close).toHaveBeenCalledOnce();
	expect(c.remove).not.toHaveBeenCalled();
	c.detect.mockReturnValue(undefined);
	await expect(c.removeWorktree(c.run, "/scratch", true)).rejects.toThrow("no sandbox");
});

it("uses the retained confinement and leaves ordinary trusted cleanup unchanged", async () => {
	const c = cleanup();
	c.run.mutationScratch = { close: c.close };
	await c.removeWorktree(c.run, "/scratch");
	expect(c.close).toHaveBeenCalledOnce();
	expect(c.remove).not.toHaveBeenCalled();
	c.run.mutationScratch = undefined;
	await c.removeWorktree(c.run, "/scratch");
	expect(c.remove).toHaveBeenCalledOnce();
});

it.each(["/tmp/melian-static-old", "/tmp/melian-static-old/tree"])(
	"refuses the stale symlink component %s with fake process and delete controls",
	async (path) => {
		const c = cleanup();
		c.fileInfo.mockImplementation(async (asked) => ({
			ok: true,
			value: { kind: asked === path ? "symlink" : "file" },
		}));
		await expect(c.removeStaleWorktrees(c.run, "/scratch")).rejects.toThrow(`refused symlink ${path}`);
		expect(c.remove).not.toHaveBeenCalled();
		expect(c.close).not.toHaveBeenCalled();
	},
);

it("recognises live mutation locks and confines both new and legacy stale mutation trees", async () => {
	const c = cleanup();
	c.shell.mockResolvedValue({ code: 0 });
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.shell).toHaveBeenCalledExactlyOnceWith("kill -0 120 2> /dev/null");
	expect(c.close).not.toHaveBeenCalled();
	c.shell.mockResolvedValue({ code: 1 });
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.close).toHaveBeenCalledOnce();
	c.run.readOutput = async () => "worktree /tmp/melian-static-old/tree\0locked melian-static pid 120\0\0";
	c.fileInfo.mockImplementation(async (path) => ({
		ok: true,
		value: { kind: path.endsWith("/.git") ? "directory" : "file" },
	}));
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.close).toHaveBeenCalledTimes(2);
	expect(c.remove).not.toHaveBeenCalled();
});
