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
	// The marker beside each registration, by entry name: its text, or "unreadable" for a read that fails.
	const markers = new Map<string, string>();
	const readTextFile = vi.fn(async (path: string) => {
		const entry = posix.basename(posix.dirname(path));
		const text = posix.basename(path) === "gitdir" ? registered.get(entry) : markers.get(entry);
		if (text === "unreadable") return { ok: false, error: { code: "permission_denied" } };
		return text === undefined ? { ok: false, error: { code: "not_found" } } : { ok: true, value: text };
	});
	remove.mockImplementation(async (path: string) => {
		registered.delete(posix.basename(path));
		return { ok: true, value: undefined };
	});
	const commonDirectory = vi.fn(async (_command: string) => ({ code: 0, output: "/repo/.git" }));
	const run = {
		input: { env: { remove, fileInfo, listDir, readTextFile }, settings: {}, repoRoot: "/repo", tool: "biome" },
		context: {},
		notes: [] as string[],
		fail: (_code: string, message: string) => new Error(message),
		shell,
		worktreeCommand: vi.fn(async (_command: string) => ({ code: 0 })),
		readOutput: async () => "worktree /tmp/melian-confined-old/tree\0locked melian-static pid 120\0\0",
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
		scratchPrefix: "melian-static-",
		confinedScratchPrefix: "melian-confined-",
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
		markers,
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

// What host git was asked to do beyond listing the worktrees.
function hostGit(c: ReturnType<typeof cleanup>): string[] {
	return c.worktreeCommand.mock.calls.map(([command]) => command).filter((command) => !command.startsWith("list "));
}

// A crashed confined run as the listing shows it: registered, marked, and locked by a process that is gone.
function crashedConfined(c: ReturnType<typeof cleanup>) {
	c.registered.set("old", "/tmp/melian-confined-old/tree/.git\n");
	c.markers.set("old", JSON.stringify({ tree: "/tmp/melian-confined-old/tree", pid: 120 }));
}

it.each(["/tmp/melian-confined-old", "/tmp/melian-confined-old/tree"])(
	"leaves a dead run whose path %s is now a link, drops its registration, and goes on",
	async (path) => {
		const c = cleanup();
		crashedConfined(c);
		c.registered.set("users", "/home/user/stale/.git");
		c.fileInfo.mockImplementation(async (asked) => ({
			ok: true,
			value: { kind: asked === path ? "symlink" : "file" },
		}));
		await expect(c.removeStaleWorktrees(c.run, "/scratch")).resolves.toBeUndefined();
		expect(c.run.notes).toEqual(left("its path is now a symbolic link, so only its registration was removed"));
		// Its own entry and nothing else: nothing is removed through the link, on the host or confined.
		expect(c.remove.mock.calls).toEqual([["/repo/.git/worktrees/old", { recursive: true, force: true }, {}]]);
		expect([...c.registered.keys()]).toEqual(["users"]);
		expect(c.open).not.toHaveBeenCalled();
		expect(c.close).not.toHaveBeenCalled();
		expect(hostGit(c)).toEqual([]);
	},
);

// A Biome or tsc run that was confined: scratch under the ordinary prefix, and a marker that says so.
function crashedStatic(c: ReturnType<typeof cleanup>, confined: boolean) {
	c.run.readOutput = async () => "worktree /tmp/melian-static-old/tree\0locked melian-static pid 120\0\0";
	c.registered.set("old", "/tmp/melian-static-old/tree/.git");
	c.markers.set(
		"old",
		JSON.stringify({ tree: "/tmp/melian-static-old/tree", pid: 120, ...(confined ? { confined } : {}) }),
	);
}

it("removes a dead static run's tree confined when its marker says a confined command ran there", async () => {
	const c = cleanup();
	crashedStatic(c, true);
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.open).toHaveBeenCalledExactlyOnceWith(expect.anything(), "/tmp/melian-static-old", expect.anything(), []);
	expect(c.close).toHaveBeenCalledOnce();
	expect(hostGit(c)).toEqual([]);
	// The host deletes the registration's own entry and never the scratch directory.
	expect(c.remove.mock.calls.map(([path]) => path)).toEqual(["/repo/.git/worktrees/old"]);
	expect(c.run.notes).toEqual([]);
	const unmarked = cleanup();
	crashedStatic(unmarked, false);
	await unmarked.removeStaleWorktrees(unmarked.run, "/scratch");
	expect(unmarked.open).not.toHaveBeenCalled();
	expect(hostGit(unmarked)).toHaveLength(2);
});

it("leaves such a tree with a note on a host with no sandbox, and reads only true as confined", async () => {
	const c = cleanup();
	crashedStatic(c, true);
	c.detect.mockReturnValue(undefined);
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.run.notes).toEqual(
		left(
			"only confined cleanup may remove it, and this host offers no sandbox; review from a host that has one, or remove it yourself with git worktree remove --force --force /tmp/melian-static-old/tree and delete /tmp/melian-static-old",
			"/tmp/melian-static-old/tree",
		),
	);
	expect(c.remove).not.toHaveBeenCalled();
	expect(hostGit(c)).toEqual([]);
	const truthy = cleanup();
	crashedStatic(truthy, false);
	truthy.markers.set("old", JSON.stringify({ tree: "/tmp/melian-static-old/tree", pid: 120, confined: "yes" }));
	await truthy.removeStaleWorktrees(truthy.run, "/scratch");
	expect(truthy.open).not.toHaveBeenCalled();
	expect(hostGit(truthy)).toHaveLength(2);
});

it("says so when the host cannot remove a dead run's scratch", async () => {
	const c = cleanup();
	crashedStatic(c, false);
	c.remove.mockResolvedValue({
		ok: false,
		error: { code: "permission_denied", message: "a directory is unreadable" },
	});
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.run.notes).toEqual(["biome could not remove /tmp/melian-static-old: a directory is unreadable."]);
});

it("leaves a live run alone and removes a dead confined one only confined", async () => {
	const c = cleanup();
	crashedConfined(c);
	c.shell.mockResolvedValue({ code: 0 });
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.shell).toHaveBeenCalledExactlyOnceWith("kill -0 120 2> /dev/null");
	expect(c.close).not.toHaveBeenCalled();
	expect(c.readTextFile).not.toHaveBeenCalled();
	expect(c.run.notes).toEqual([]);
	c.shell.mockResolvedValue({ code: 1 });
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.open).toHaveBeenCalledExactlyOnceWith(expect.anything(), "/tmp/melian-confined-old", expect.anything(), []);
	expect(c.close).toHaveBeenCalledOnce();
	expect(c.registered.has("old")).toBe(false);
	expect(hostGit(c)).toEqual([]);
	expect(c.run.notes).toEqual([]);
});

const left = (why: string, path = "/tmp/melian-confined-old/tree") => [
	`biome left the worktree at ${path} alone: ${why}.`,
];

it.each([
	["no marker", (c: ReturnType<typeof cleanup>) => c.markers.delete("old"), "it has no marker"],
	[
		"a marker for another tree",
		(c: ReturnType<typeof cleanup>) => c.markers.set("old", JSON.stringify({ tree: "/tmp/other/tree", pid: 120 })),
		"its marker names another tree or process",
	],
	[
		"a marker for another process",
		(c: ReturnType<typeof cleanup>) =>
			c.markers.set("old", JSON.stringify({ tree: "/tmp/melian-confined-old/tree", pid: 121 })),
		"its marker names another tree or process",
	],
	[
		"a marker that is not JSON",
		(c: ReturnType<typeof cleanup>) => c.markers.set("old", "tree /tmp/melian-confined-old/tree"),
		"its marker names another tree or process",
	],
	[
		"a marker that cannot be read",
		(c: ReturnType<typeof cleanup>) => c.markers.set("old", "unreadable"),
		"its marker names another tree or process",
	],
	["no registration to hold a marker", (c: ReturnType<typeof cleanup>) => c.registered.clear(), "it has no marker"],
	[
		"no sandbox on the host",
		(c: ReturnType<typeof cleanup>) => c.detect.mockReturnValue(undefined),
		"only confined cleanup may remove it, and this host offers no sandbox; review from a host that has one, or remove it yourself with git worktree remove --force --force /tmp/melian-confined-old/tree and delete /tmp/melian-confined-old",
	],
] as const)("leaves a dead confined tree with %s, and says so", async (_name, arrange, why) => {
	const c = cleanup();
	crashedConfined(c);
	arrange(c);
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.run.notes).toEqual(left(why));
	// With no registration there is no marker to look for, so nothing is read.
	if (c.registered.size === 0) expect(c.readTextFile).not.toHaveBeenCalled();
	expect(c.close).not.toHaveBeenCalled();
	expect(c.confinedRemove).not.toHaveBeenCalled();
	expect(c.remove).not.toHaveBeenCalled();
	expect(hostGit(c)).toEqual([]);
});

it.each([
	["unlocked", "", "it is not locked, so it is not a static run's"],
	["locked with no reason", "\0locked", "its lock is not a static run's"],
	["locked by the user", "\0locked keep this", "its lock is not a static run's"],
	["locked with a longer reason", "\0locked melian-static pid 120 extra", "its lock is not a static run's"],
	[
		"locked with the retired mutation reason",
		"\0locked melian-static mutation pid 120",
		"its lock is not a static run's",
	],
] as const)("leaves a tree at a run's kind of path that is %s, under either prefix", async (_name, lock, why) => {
	for (const prefix of ["melian-static-", "melian-confined-"]) {
		const c = cleanup();
		const path = `/tmp/${prefix}feature/tree`;
		c.run.readOutput = async () => `worktree ${path}${lock}\0\0`;
		c.registered.set("feature", `${path}/.git`);
		await c.removeStaleWorktrees(c.run, "/scratch");
		expect(c.run.notes).toEqual(left(why, path));
		expect(c.shell).not.toHaveBeenCalled();
		expect(c.remove).not.toHaveBeenCalled();
		expect(c.close).not.toHaveBeenCalled();
		expect(hostGit(c)).toEqual([]);
	}
});

it("removes a dead static run's tree on the host, marked or from a build before the marker", async () => {
	for (const marker of [undefined, JSON.stringify({ tree: "/tmp/melian-static-old/base/tree", pid: 120 })]) {
		const c = cleanup();
		c.run.readOutput = async () => "worktree /tmp/melian-static-old/base/tree\0locked melian-static pid 120\0\0";
		c.registered.set("old", "/tmp/melian-static-old/base/tree/.git");
		if (marker !== undefined) c.markers.set("old", marker);
		await c.removeStaleWorktrees(c.run, "/scratch");
		expect(hostGit(c)).toEqual([
			"worktree remove --force --force /tmp/melian-static-old/base/tree",
			"worktree remove --force --force /tmp/melian-static-old/tree",
		]);
		expect(c.remove).toHaveBeenCalledExactlyOnceWith("/tmp/melian-static-old", { recursive: true, force: true }, {});
		expect(c.open).not.toHaveBeenCalled();
		expect(c.detect).not.toHaveBeenCalled();
		expect(c.run.notes).toEqual([]);
	}
});

it("leaves a dead static run's tree whose marker names another tree", async () => {
	const c = cleanup();
	c.run.readOutput = async () => "worktree /tmp/melian-static-old/tree\0locked melian-static pid 120\0\0";
	c.registered.set("old", "/tmp/melian-static-old/tree/.git");
	c.markers.set("old", JSON.stringify({ tree: "/tmp/melian-static-other/tree", pid: 120 }));
	await c.removeStaleWorktrees(c.run, "/scratch");
	expect(c.run.notes).toEqual(left("its marker names another tree or process", "/tmp/melian-static-old/tree"));
	expect(c.remove).not.toHaveBeenCalled();
	expect(hostGit(c)).toEqual([]);
});

it("skips its own scratch, other names, and a lock held by pid 0 or 1 is dead", async () => {
	const c = cleanup();
	c.run.readOutput = async () =>
		[
			"worktree /tmp/melian-static-mine/tree\0locked melian-static pid 120",
			"worktree /tmp/melian-static-old/nottree\0locked melian-static pid 120",
			"worktree /tmp/users-feature/tree",
			"worktree /tmp/melian-static-one/tree\0locked melian-static pid 1",
			"",
		].join("\0\0");
	await c.removeStaleWorktrees(c.run, "/tmp/melian-static-mine");
	expect(c.shell).not.toHaveBeenCalled();
	expect(c.run.notes).toEqual([]);
	expect(c.remove).toHaveBeenCalledExactlyOnceWith("/tmp/melian-static-one", { recursive: true, force: true }, {});
});

// Every awaited step of the confined teardown: two tree removals, the close, and for each tree the common-directory
// lookup, the listing, the gitdir reads, and the removal of its entry.
it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("replays confined cleanup after a crash at step %s", async (crash) => {
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
});

it("completes the confined teardown in twelve steps, so the replay test covers each", async () => {
	const c = cleanup();
	c.registered.set("tree", "/scratch/tree/.git");
	c.registered.set("tree1", "/scratch/base/tree/.git");
	c.registered.set("users", "/home/user/stale/.git");
	await c.removeWorktree(c.run, "/scratch", true);
	const calls = [c.confinedRemove, c.close, c.commonDirectory, c.listDir, c.readTextFile, c.remove];
	expect(calls.reduce((total, mock) => total + mock.mock.calls.length, 0)).toBe(12);
});
