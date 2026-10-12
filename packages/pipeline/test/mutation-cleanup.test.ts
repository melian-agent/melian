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
	const shell = vi.fn(async (_command: string): Promise<{ code: number; output?: string }> => ({ code: 1 }));
	const fileInfo = vi.fn(async (_path: string) => ({ ok: true, value: { kind: "file" } }));
	// The repository's registrations: each entry's name and what its `gitdir` file holds, or undefined for none.
	const registered = new Map<string, string | undefined>();
	const listDir = vi.fn(async (_path: string) =>
		registered.size === 0
			? { ok: false, error: { code: "not_found", message: "no worktrees" } }
			: { ok: true, value: [...registered.keys()].map((name) => ({ name })) },
	);
	const readTextFile = vi.fn(async (path: string) => {
		const text = registered.get(posix.basename(posix.dirname(path)));
		return text === undefined ? { ok: false, error: { code: "not_found" } } : { ok: true, value: text };
	});
	remove.mockImplementation(async (path: string) => {
		registered.delete(posix.basename(path));
		return { ok: true, value: undefined };
	});
	const commonDirectory = vi.fn(async (_command: string) => ({ code: 0, output: "/repo/.git" }));
	const run = {
		input: { env: { remove, fileInfo, listDir, readTextFile }, settings: {}, repoRoot: "/repo" },
		context: {},
		fail: (_code: string, message: string) => new Error(message),
		shell,
		worktreeCommand: vi.fn(async (_command: string) => ({ code: 0 })),
		readOutput: async () => "worktree /tmp/melian-static-old/tree\0locked melian-static mutation pid 120\0\0",
		mutationScratch: undefined as { close: typeof close; remove: typeof confinedRemove } | undefined,
	};
	class FakeRun {
		input = run.input;
		worktreeCommand = run.worktreeCommand;
		shell = commonDirectory;
		fail = run.fail;
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
		registered,
		listDir,
		readTextFile,
		commonDirectory,
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

it("removes only its own registrations, last, and never asks host git to prune or remove", async () => {
	const c = cleanup();
	c.run.mutationScratch = { close: c.close, remove: c.confinedRemove };
	c.registered.set("tree", "/scratch/tree/.git\n");
	c.registered.set("tree1", "/scratch/base/tree/.git\n");
	c.registered.set("users", "/home/user/stale/.git\n");
	c.registered.set("relative", "../../../../scratch/elsewhere/tree/.git\n");
	c.registered.set("broken", undefined);
	const order: string[] = [];
	c.confinedRemove.mockImplementation(async (path) => void order.push(`confined remove ${path}`));
	c.close.mockImplementation(async () => void order.push("close"));
	const unregister = c.remove.getMockImplementation()!;
	c.remove.mockImplementation(async (path: string) => {
		order.push(`unregister ${path}`);
		return unregister(path);
	});
	await c.removeWorktree(c.run, "/scratch");
	expect(order).toEqual([
		"confined remove /scratch/base/tree",
		"confined remove /scratch/tree",
		"close",
		"unregister /repo/.git/worktrees/tree1",
		"unregister /repo/.git/worktrees/tree",
	]);
	expect(c.remove.mock.calls.map(([, options]) => options)).toEqual([
		{ recursive: true, force: true },
		{ recursive: true, force: true },
	]);
	expect([...c.registered.keys()]).toEqual(["users", "relative", "broken"]);
	expect(c.commonDirectory).toHaveBeenCalledWith("rev-parse --path-format=absolute --git-common-dir");
	expect(c.listDir).toHaveBeenCalledWith("/repo/.git/worktrees", {});
	expect(c.readTextFile).toHaveBeenCalledWith("/repo/.git/worktrees/tree/gitdir", {});
	expect(c.worktreeCommand).not.toHaveBeenCalled();
});

it("resolves a relative gitdir against its entry before comparing", async () => {
	const c = cleanup();
	c.run.mutationScratch = { close: c.close, remove: c.confinedRemove };
	c.registered.set("tree", "../../../../scratch/tree/.git\n");
	await c.removeWorktree(c.run, "/scratch");
	expect(c.registered.size).toBe(0);
});

it.each([
	["the common directory cannot be found", "git rev-parse failed: not a repository"],
	["the registrations cannot be listed", "could not list /repo/.git/worktrees: denied"],
	["a registration cannot be removed", "could not remove /repo/.git/worktrees/tree: busy"],
])("fails the teardown when %s", async (fault, message) => {
	const c = cleanup();
	c.run.mutationScratch = { close: c.close, remove: c.confinedRemove };
	c.registered.set("tree", "/scratch/tree/.git");
	if (fault.startsWith("the common")) c.commonDirectory.mockResolvedValue({ code: 128, output: "not a repository" });
	if (fault.startsWith("the registrations"))
		c.listDir.mockResolvedValue({ ok: false, error: { code: "permission_denied", message: "denied" } });
	if (fault.startsWith("a registration"))
		c.remove.mockResolvedValue({ ok: false, error: { code: "unknown", message: "busy" } });
	await expect(c.removeWorktree(c.run, "/scratch")).rejects.toThrow(message);
	expect(c.registered.has("tree")).toBe(true);
});

it("treats a repository with no registrations left as already unregistered", async () => {
	const c = cleanup();
	c.run.mutationScratch = { close: c.close, remove: c.confinedRemove };
	await expect(c.removeWorktree(c.run, "/scratch")).resolves.toBeUndefined();
	expect(c.listDir).toHaveBeenCalledTimes(2);
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

// Every awaited step of the confined teardown: two tree removals, the close, and for each tree the common-directory
// lookup, the listing, the gitdir reads, and the removal of its entry.
it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])(
	"replays confined cleanup after a crash at step %s",
	async (crash) => {
		const c = cleanup();
		const roots = new Set(["/scratch/base/tree", "/scratch/tree"]);
		c.registered.set("tree", "/scratch/tree/.git");
		c.registered.set("tree1", "/scratch/base/tree/.git");
		c.registered.set("users", "/home/user/stale/.git");
		let scratch = true;
		let step = 0;
		const checkpoint = () => {
			if (++step === crash) throw new Error("crash");
		};
		const stepping = <A extends unknown[], R>(mock: { getMockImplementation(): ((...args: A) => R) | undefined }) => {
			const original = mock.getMockImplementation()!;
			return (...args: A): R => {
				checkpoint();
				return original(...args);
			};
		};
		c.confinedRemove.mockImplementation(async (path) => {
			checkpoint();
			roots.delete(path);
		});
		c.close.mockImplementation(async () => {
			checkpoint();
			expect(roots.size).toBe(0);
			scratch = false;
		});
		c.commonDirectory.mockImplementation(stepping(c.commonDirectory));
		c.listDir.mockImplementation(stepping(c.listDir));
		c.readTextFile.mockImplementation(stepping(c.readTextFile));
		const unregister = c.remove.getMockImplementation()!;
		c.remove.mockImplementation(async (path: string) => {
			checkpoint();
			// The registration is the record that cleanup is owed, so it outlives everything it guards.
			expect(scratch).toBe(false);
			return unregister(path);
		});
		await expect(c.removeWorktree(c.run, "/scratch", true)).rejects.toThrow("crash");
		await c.removeWorktree(c.run, "/scratch", true);
		expect({ registered: [...c.registered.keys()], scratch, roots: roots.size }).toEqual({
			registered: ["users"],
			scratch: false,
			roots: 0,
		});
		expect(c.worktreeCommand).not.toHaveBeenCalled();
	},
);

it("completes the confined teardown in fourteen steps, so the replay test covers each", async () => {
	const c = cleanup();
	c.registered.set("tree", "/scratch/tree/.git");
	c.registered.set("tree1", "/scratch/base/tree/.git");
	c.registered.set("users", "/home/user/stale/.git");
	await c.removeWorktree(c.run, "/scratch", true);
	const calls = [c.confinedRemove, c.close, c.commonDirectory, c.listDir, c.readTextFile, c.remove];
	expect(calls.reduce((total, mock) => total + mock.mock.calls.length, 0)).toBe(14);
});
