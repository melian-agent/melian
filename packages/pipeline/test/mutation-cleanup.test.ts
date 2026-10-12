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
	const confinedRemove = vi.fn(async (_path: string) => {});
	const open = vi.fn(() => ({ close, remove: confinedRemove }));
	const detect = vi.fn((): object | undefined => ({}));
	const shell = vi.fn(async () => ({ code: 1 }));
	const fileInfo = vi.fn(async (_path: string) => ({ ok: true, value: { kind: "file" } }));
	const run = {
		input: { env: { remove, fileInfo }, settings: {}, repoRoot: "/repo" },
		context: {},
		fail: (_code: string, message: string) => new Error(message),
		shell,
		worktreeCommand: vi.fn(async (_command: string) => ({ code: 0 })),
		readOutput: async () => "worktree /tmp/melian-static-old/tree\0locked melian-static mutation pid 120\0\0",
		mutationScratch: undefined as { close: typeof close; remove: typeof confinedRemove } | undefined,
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
	return {
		...functions,
		run,
		remove,
		close,
		confinedRemove,
		open,
		detect,
		shell,
		fileInfo,
		worktreeCommand: run.worktreeCommand,
	};
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
	c.run.mutationScratch = { close: c.close, remove: c.confinedRemove };
	await c.removeWorktree(c.run, "/scratch");
	expect(c.close).toHaveBeenCalledOnce();
	expect(c.remove).not.toHaveBeenCalled();
	c.run.mutationScratch = undefined;
	await c.removeWorktree(c.run, "/scratch");
	expect(c.remove).toHaveBeenCalledOnce();
});

it("unregisters confined worktrees without asking host git to delete a head-written path", async () => {
	const c = cleanup();
	c.run.mutationScratch = { close: c.close, remove: c.confinedRemove };
	await c.removeWorktree(c.run, "/scratch");
	expect(c.worktreeCommand.mock.calls.map(([command]) => command)).toEqual([
		"worktree unlock /scratch/base/tree",
		"worktree unlock /scratch/tree",
		"worktree prune --expire=now",
	]);
	expect(c.close).toHaveBeenCalledOnce();
	expect(c.remove).not.toHaveBeenCalled();
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

it.each([1, 2, 3, 4, 5, 6])("replays confined cleanup after a crash at step %s", async (crash) => {
	const c = cleanup();
	const roots = new Set(["/scratch/base/tree", "/scratch/tree"]);
	const locks = new Set(roots);
	let registered = true;
	let scratch = true;
	let step = 0;
	const checkpoint = () => {
		if (++step === crash) throw new Error("crash");
	};
	c.worktreeCommand.mockImplementation(async (command) => {
		if (command.startsWith("worktree unlock ")) locks.delete(command.slice("worktree unlock ".length));
		else {
			expect(locks.size).toBe(0);
			expect(roots.size).toBe(0);
			registered = false;
		}
		checkpoint();
		return { code: 1 };
	});
	c.confinedRemove.mockImplementation(async (path) => {
		roots.delete(path);
		checkpoint();
	});
	c.close.mockImplementation(async () => {
		expect(registered).toBe(false);
		scratch = false;
		checkpoint();
	});
	await expect(c.removeWorktree(c.run, "/scratch", true)).rejects.toThrow("crash");
	await c.removeWorktree(c.run, "/scratch", true);
	expect({ registered, scratch, locks: locks.size, roots: roots.size }).toEqual({
		registered: false,
		scratch: false,
		locks: 0,
		roots: 0,
	});
	expect(c.remove).not.toHaveBeenCalled();
});
