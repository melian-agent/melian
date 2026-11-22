import { RecordError, recordLimit } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deadline, systemClock } from "../src/deadline.ts";
import type { GitRecordStore, Retirement } from "../src/index.ts";
import { RecordRepository, type TreeChange } from "../src/repository.ts";
import { cellPath, entryLimit, listingLimit, StateTree, tipLimit } from "../src/state-tree.ts";
import { changeset, check, filed, keys, other, type Planted, Remote } from "./fixtures/remote.ts";

const third = "pull-fedcba9876543210";
const limit = 65_536;
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await remote.close();
});

function retirement(found: Partial<Retirement>): Retirement {
	return { removed: [], kept: [], changed: [], strays: [], absent: [], deferred: [], ...found };
}

function sorted(found: Retirement): Retirement {
	return {
		removed: [...found.removed].sort(),
		kept: [...found.kept].sort(),
		changed: [...found.changed].sort(),
		strays: [...found.strays].sort(),
		absent: [...found.absent].sort(),
		deferred: [...found.deferred].sort(),
	};
}

function under(name: string): string[] {
	return remote.files().filter((path) => path.startsWith(`changesets/${name}/`));
}

function removals(name: string): TreeChange[] {
	return under(name).map((path) => ({ path, bytes: null }));
}

function treeOf(name: string): string {
	return remote.git(["rev-parse", `refs/heads/${remote.branch}:changesets/${name}`]);
}

function roots(count: number): Record<string, Planted> {
	return Object.fromEntries(Array.from({ length: count }, (_, n) => [`noise/${n}`, { bytes: "" }] as const));
}

// A store holding two records in `changeset` and one in `other`, and no cell, so a retire may remove either folder.
async function seeded(): Promise<GitRecordStore> {
	const store = await remote.open();
	await store.add([check("a"), check("b"), check("kept", other)]);
	return store;
}

async function plumb(repository: RecordRepository, args: string[], deadline: Deadline, input?: string) {
	const result = await repository.run(args, deadline, input === undefined ? {} : { input });
	if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	return result.stdout.trim();
}

// The top level of `treeish`, one `<mode> <type> <oid>\t<name>` line each.
async function level(repository: RecordRepository, treeish: string, deadline: Deadline): Promise<string[]> {
	return (await plumb(repository, ["ls-tree", "--full-tree", treeish], deadline)).split("\n").filter(Boolean);
}

async function mktree(repository: RecordRepository, lines: readonly string[], deadline: Deadline): Promise<string> {
	return plumb(repository, ["mktree"], deadline, lines.map((line) => `${line}\n`).join(""));
}

async function blob(repository: RecordRepository, bytes: string, deadline: Deadline): Promise<string> {
	return plumb(repository, ["hash-object", "-w", "--no-filters", "--stdin"], deadline, bytes);
}

async function commitOf(repository: RecordRepository, tree: string, parents: readonly string[], deadline: Deadline) {
	return plumb(
		repository,
		["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", "crafted"],
		deadline,
	);
}

type Craft = (repository: RecordRepository, parent: string, deadline: Deadline) => Promise<string>;

// The next `withoutFolders` builds what `craft` says instead, inside the store's own repository, on the tip it read.
function crafting(craft: Craft) {
	const crafted: string[] = [];
	const spy = vi.spyOn(RecordRepository.prototype, "withoutFolders").mockImplementationOnce(async function (
		this: RecordRepository,
		parent,
		_names,
		deadline,
	) {
		const commit = await craft(this, parent, deadline);
		crafted.push(commit);
		return commit;
	});
	return { spy, crafted };
}

// Retires `changeset` with `craft` standing in for the commit, and expects the rule to refuse it and nothing to land.
async function refuses(craft: Craft): Promise<void> {
	const store = await seeded();
	remote.plant({ "notes.txt": { bytes: "root" } });
	const seen = await store.folders();
	const tip = remote.tip();
	const { crafted } = crafting(craft);
	const rule = vi.spyOn(StateTree, "removesOnly");
	const push = vi.spyOn(RecordRepository.prototype, "push");
	await expect(store.retire(new Map([[changeset, seen.get(changeset)!]]))).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(RecordError);
		expect((error as RecordError).code).toBe("unreachable");
		expect((error as RecordError).message).toBe(
			`the commit retiring ${changeset} changes more of ${remote.branch} than it removes; nothing was pushed`,
		);
		return true;
	});
	expect(crafted).toHaveLength(1);
	expect(rule).toHaveBeenCalledWith(expect.any(RecordRepository), tip, crafted[0], expect.anything());
	await expect(rule.mock.results[0]!.value).resolves.toBe(false);
	expect(push).not.toHaveBeenCalled();
	expect(remote.tip()).toBe(tip);
}

describe("the removal-only rule", { timeout: 60_000 }, () => {
	it("accepts a crafted commit that removes the folder alone, so the crafts below are refused for what they add", async () => {
		const store = await seeded();
		const seen = await store.folders();
		const gone = removals(changeset);
		crafting((repository, parent, deadline) => repository.commit(parent, gone, deadline));
		expect(await store.retire(new Map([[changeset, seen.get(changeset)!]]))).toEqual(
			retirement({ removed: [changeset] }),
		);
		expect(under(changeset)).toEqual([]);
		expect(keys(await store.list(other))).toEqual(["kept"]);
	});

	it("refuses a commit that removes one folder and adds a record to another changeset's folder", async () => {
		const added = filed(check("added", other));
		await refuses((repository, parent, deadline) =>
			repository.commit(parent, [...removals(changeset), added], deadline),
		);
	});

	it("refuses a commit that removes one folder and adds a folder for a changeset the parent lacks", async () => {
		const added = filed(check("added", third));
		await refuses((repository, parent, deadline) =>
			repository.commit(parent, [...removals(changeset), added], deadline),
		);
	});

	it("refuses a commit that removes one folder and renames another, its bytes kept under a new name", async () => {
		await refuses(async (repository, parent, deadline) => {
			const moved = await Promise.all(
				under(other).map(async (path) => ({
					path: path.replace(`changesets/${other}/`, `changesets/${third}/`),
					bytes: await plumb(repository, ["cat-file", "blob", `${parent}:${path}`], deadline),
				})),
			);
			return repository.commit(parent, [...removals(changeset), ...removals(other), ...moved], deadline);
		});
	});

	it("refuses a commit that replaces a folder with a file of the same name", async () => {
		await refuses(async (repository, parent, deadline) => {
			const file = await blob(repository, "not a folder", deadline);
			const folders = (await level(repository, `${parent}:changesets`, deadline)).map((line) =>
				line.endsWith(`\t${changeset}`) ? `100644 blob ${file}\t${changeset}` : line,
			);
			const inner = await mktree(repository, folders, deadline);
			const root = (await level(repository, parent, deadline)).map((line) =>
				line.endsWith("\tchangesets") ? `040000 tree ${inner}\tchangesets` : line,
			);
			return commitOf(repository, await mktree(repository, root, deadline), [parent], deadline);
		});
	});

	it("refuses a commit that removes one folder and changes a record in a kept folder", async () => {
		const [kept] = under(other);
		await refuses((repository, parent, deadline) =>
			repository.commit(parent, [...removals(changeset), { path: kept!, bytes: "{}" }], deadline),
		);
	});

	it("refuses a commit that removes part of a folder", async () => {
		const [first] = under(changeset);
		await refuses((repository, parent, deadline) =>
			repository.commit(parent, [{ path: first!, bytes: null }], deadline),
		);
	});

	it("refuses a commit that removes one folder and adds a file at the root", async () => {
		await refuses((repository, parent, deadline) =>
			repository.commit(parent, [...removals(changeset), { path: "added.txt", bytes: "x" }], deadline),
		);
	});

	it("refuses a commit that removes one folder and changes a file at the root", async () => {
		await refuses((repository, parent, deadline) =>
			repository.commit(parent, [...removals(changeset), { path: "notes.txt", bytes: "changed" }], deadline),
		);
	});

	it("refuses a commit that removes one folder and removes a file at the root", async () => {
		await refuses((repository, parent, deadline) =>
			repository.commit(parent, [...removals(changeset), { path: "notes.txt", bytes: null }], deadline),
		);
	});

	it("refuses a commit that removes one folder and changes only the mode of a file at the root", async () => {
		await refuses(async (repository, parent, deadline) => {
			const removed = await repository.commit(parent, removals(changeset), deadline);
			const root = (await level(repository, removed, deadline)).map((line) =>
				line.endsWith("\tnotes.txt") ? line.replace(/^100644 /, "100755 ") : line,
			);
			return commitOf(repository, await mktree(repository, root, deadline), [parent], deadline);
		});
	});

	it("refuses a commit that turns `changesets` into a file", async () => {
		await refuses(async (repository, parent, deadline) => {
			const file = await blob(repository, "not a tree", deadline);
			const root = (await level(repository, parent, deadline)).map((line) =>
				line.endsWith("\tchangesets") ? `100644 blob ${file}\tchangesets` : line,
			);
			return commitOf(repository, await mktree(repository, root, deadline), [parent], deadline);
		});
	});

	it("refuses a commit that drops `changesets` whole and changes a file at the root", async () => {
		await refuses((repository, parent, deadline) =>
			repository.commit(
				parent,
				[...removals(changeset), ...removals(other), { path: "notes.txt", bytes: "changed" }],
				deadline,
			),
		);
	});

	it("refuses a commit whose tree is the parent's, since it removes nothing", async () => {
		await refuses((repository, parent, deadline) => repository.commit(parent, [], deadline));
	});

	// The rule as briefed compares trees alone. A commit that does not sit on the tip it read would be pushed with a
	// lease that still holds, and rewrite the branch's history where no ruleset forbids it.
	it("refuses a removal-only tree on a commit with no parent, which would rewrite the branch's history", async () => {
		await refuses(async (repository, parent, deadline) => {
			const removed = await repository.commit(parent, removals(changeset), deadline);
			return commitOf(
				repository,
				await plumb(repository, ["rev-parse", `${removed}^{tree}`], deadline),
				[],
				deadline,
			);
		});
	});

	it("refuses a removal-only tree on a merge of the tip with another commit", async () => {
		await refuses(async (repository, parent, deadline) => {
			const removed = await repository.commit(parent, removals(changeset), deadline);
			const tree = await plumb(repository, ["rev-parse", `${removed}^{tree}`], deadline);
			const aside = await commitOf(repository, tree, [], deadline);
			return commitOf(repository, tree, [parent, aside], deadline);
		});
	});

	// Removing every folder leaves no `changesets` tree, since git keeps no empty tree. That is the most a retire can
	// remove, so it must be accepted, though "the new `changesets` is a tree" read literally refuses it.
	it("accepts retiring every changeset, which leaves no `changesets` tree, and keeps the root's files", async () => {
		const store = await seeded();
		remote.plant({ "notes.txt": { bytes: "root" } });
		const seen = await store.folders();
		expect(sorted(await store.retire(seen))).toEqual(retirement({ removed: [changeset, other].sort() }));
		expect(remote.files()).toEqual(["notes.txt"]);
		expect(remote.git(["ls-tree", "--full-tree", remote.tip()!])).not.toContain("changesets");
		expect(remote.git(["log", "-1", "--format=%s", remote.tip()!])).toBe("melian: retire");
	});
});

describe("a retire past the store's limits", { timeout: 300_000 }, () => {
	it("pushes a removal-only commit on a tip one entry past the entry limit, keeping the root's strays", async () => {
		const store = await seeded();
		remote.plant(roots(limit + 1));
		await expect(store.strays()).rejects.toMatchObject({ code: "unreachable" });
		const seen = await store.folders();
		expect(sorted(await store.retire(seen))).toEqual(retirement({ removed: [changeset, other].sort() }));
		const files = remote.files();
		expect(files).toHaveLength(limit + 1);
		expect(files.every((path) => path.startsWith("noise/"))).toBe(true);
	});

	it("leaves every other write to the limits after it retires", async () => {
		const store = await seeded();
		remote.plant(roots(limit + 1));
		await store.retire(new Map([[changeset, (await store.folders()).get(changeset)!]]));
		const tip = remote.tip();
		await expect(store.add([check("late", other)])).rejects.toMatchObject({ code: "unreachable" });
		await expect(store.dispose(other)).rejects.toMatchObject({ code: "unreachable" });
		expect(remote.tip()).toBe(tip);
	});

	it("pushes a removal-only commit on a tip exactly at the entry limit", async () => {
		const store = await seeded();
		remote.plant(roots(limit - remote.files().length));
		expect(remote.files()).toHaveLength(limit);
		const seen = await store.folders();
		expect(await store.retire(new Map([[changeset, seen.get(changeset)!]]))).toEqual(
			retirement({ removed: [changeset] }),
		);
		expect(under(changeset)).toEqual([]);
		expect(under(other)).toHaveLength(1);
	});

	it("pushes a removal-only commit on a tip whose records git reports past the byte limit", async () => {
		const store = await seeded();
		await store.add(Array.from({ length: 65 }, (_, n) => check(`r${n}`, other)));
		const seen = await store.folders();
		vi.spyOn(RecordRepository.prototype, "sizes").mockImplementation(
			async (oids) => new Map(oids.map((oid) => [oid, recordLimit])),
		);
		await expect(store.list(other)).rejects.toMatchObject({ code: "unreachable" });
		expect(await store.retire(new Map([[changeset, seen.get(changeset)!]]))).toEqual(
			retirement({ removed: [changeset] }),
		);
		expect(under(changeset)).toEqual([]);
	});
});

describe("a retire that races", { timeout: 120_000 }, () => {
	it("keeps a folder a round's add changed just before its push, reports it changed, and removes the rest", async () => {
		const store = await seeded();
		const rival = await remote.open();
		const seen = await store.folders();
		const push = RecordRepository.prototype.push;
		const spy = vi.spyOn(RecordRepository.prototype, "push").mockImplementationOnce(async function (
			this: RecordRepository,
			...args
		) {
			await rival.add([check("late")]);
			return push.apply(this, args);
		});
		expect(await store.retire(seen)).toEqual(retirement({ removed: [other], changed: [changeset] }));
		// The store's first push, the rival's inside it, and the store's push on the fresh tip.
		expect(spy).toHaveBeenCalledTimes(3);
		expect(keys(await store.list(changeset))).toEqual(["a", "b", "late"]);
		expect(under(other)).toEqual([]);
	});

	it("pushes nothing more when the race leaves nothing to remove", async () => {
		const store = await seeded();
		const rival = await remote.open();
		const seen = await store.folders();
		const push = RecordRepository.prototype.push;
		const spy = vi.spyOn(RecordRepository.prototype, "push").mockImplementationOnce(async function (
			this: RecordRepository,
			...args
		) {
			await rival.add([check("late")]);
			return push.apply(this, args);
		});
		expect(await store.retire(new Map([[changeset, seen.get(changeset)!]]))).toEqual(
			retirement({ changed: [changeset] }),
		);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(keys(await store.list(changeset))).toEqual(["a", "b", "late"]);
	});

	it("lets an add after the retire start the changeset afresh", async () => {
		const store = await seeded();
		const rival = await remote.open();
		await store.retire(new Map([[changeset, (await store.folders()).get(changeset)!]]));
		expect(await rival.readCell(changeset)).toEqual({});
		expect(await rival.list(changeset)).toEqual([]);
		await rival.add([check("fresh")]);
		expect(keys(await store.list(changeset))).toEqual(["fresh"]);
	});

	it("removes a folder once when another retire of an overlapping set lands just before its push", async () => {
		const first = await seeded();
		await first.add([check("third", third)]);
		const second = await remote.open();
		const seen = await first.folders();
		const push = RecordRepository.prototype.push;
		let theirs: Retirement | undefined;
		vi.spyOn(RecordRepository.prototype, "push").mockImplementationOnce(async function (
			this: RecordRepository,
			...args
		) {
			theirs = await second.retire(new Map([other, third].map((name) => [name, seen.get(name)!])));
			return push.apply(this, args);
		});
		const ours = await first.retire(new Map([changeset, other].map((name) => [name, seen.get(name)!])));
		expect(sorted(theirs!)).toEqual(retirement({ removed: [other, third].sort() }));
		expect(ours).toEqual(retirement({ removed: [changeset], absent: [other] }));
		expect(remote.files()).toEqual([]);
	});

	it("resolves two overlapping retires run at once, each folder removed by exactly one", async () => {
		const first = await seeded();
		await first.add([check("third", third)]);
		const second = await remote.open();
		const seen = await first.folders();
		const pick = (names: string[]) => new Map(names.map((name) => [name, seen.get(name)!]));
		const [a, b] = await Promise.all([first.retire(pick([changeset, other])), second.retire(pick([other, third]))]);
		expect([...a.removed, ...b.removed].sort()).toEqual([changeset, other, third].sort());
		expect([...a.changed, ...b.changed, ...a.strays, ...b.strays]).toEqual([]);
		expect([...a.absent, ...b.absent]).toEqual([other]);
		expect(remote.files()).toEqual([]);
	});
});

describe("a retire and strays", { timeout: 60_000 }, () => {
	const inFolder: Readonly<Record<string, (path: string) => Readonly<Record<string, Planted>>>> = {
		"a file that is not JSON": () => ({ [`changesets/${changeset}/notes.txt`]: { bytes: "notes" } }),
		"a record whose bytes do not parse": (path) => ({ [path]: { bytes: "not json" } }),
		"a record at an executable mode": (path) => ({ [path]: { bytes: filed(check("a")).bytes, mode: "100755" } }),
		"a link at a record's path": (path) => ({ [path]: { bytes: "/etc/passwd", mode: "120000" } }),
		"another changeset's record in its folder": () => {
			const foreign = filed(check("kept", other));
			return {
				[foreign.path.replace(`changesets/${other}/`, `changesets/${changeset}/`)]: { bytes: foreign.bytes },
			};
		},
	};

	it.each(Object.keys(inFolder))(
		"keeps a folder holding %s, and its stray, and removes a clean folder",
		async (name) => {
			const store = await seeded();
			remote.plant(inFolder[name]!(filed(check("a")).path));
			const files = under(changeset);
			const seen = await store.folders();
			expect(await store.retire(seen)).toEqual(retirement({ removed: [other], strays: [changeset] }));
			expect(under(changeset)).toEqual(files);
			expect(remote.git(["rev-parse", `refs/heads/${remote.branch}:changesets/${changeset}`])).toBe(
				seen.get(changeset),
			);
			expect(under(other)).toEqual([]);
		},
	);

	it("pushes nothing when every folder it is given holds a stray", async () => {
		const store = await seeded();
		remote.plant({ [`changesets/${changeset}/notes.txt`]: { bytes: "notes" } });
		const seen = await store.folders();
		const tip = remote.tip();
		const push = vi.spyOn(RecordRepository.prototype, "push");
		expect(await store.retire(new Map([[changeset, seen.get(changeset)!]]))).toEqual(
			retirement({ strays: [changeset] }),
		);
		expect(push).not.toHaveBeenCalled();
		expect(remote.tip()).toBe(tip);
	});

	it("asks to remove only the folders it decided on", async () => {
		const store = await seeded();
		remote.plant({ [`changesets/${changeset}/notes.txt`]: { bytes: "notes" } });
		const without = vi.spyOn(RecordRepository.prototype, "withoutFolders");
		await store.retire(await store.folders());
		expect(without).toHaveBeenCalledTimes(1);
		expect(without.mock.calls[0]![1]).toEqual([other]);
	});

	it("is not blocked by a stray at the root, and leaves it", async () => {
		const store = await seeded();
		remote.plant({ "notes.txt": { bytes: "root" } });
		const seen = await store.folders();
		expect(await store.retire(new Map([[changeset, seen.get(changeset)!]]))).toEqual(
			retirement({ removed: [changeset] }),
		);
		expect(remote.files().sort()).toEqual(["notes.txt", ...under(other)].sort());
		expect(remote.oid("notes.txt")).toBe(remote.git(["hash-object", "--stdin"], remote.path, { input: "root" }));
	});

	it("is not blocked by a file directly under `changesets/`, which is no folder, and leaves it", async () => {
		const store = await seeded();
		remote.plant({ "changesets/README": { bytes: "readme" } });
		const seen = await store.folders();
		expect(seen.has("README")).toBe(false);
		expect(await store.retire(new Map([[changeset, seen.get(changeset)!]]))).toEqual(
			retirement({ removed: [changeset] }),
		);
		expect(remote.files()).toContain("changesets/README");
	});
});

describe("what a retire is given", { timeout: 60_000 }, () => {
	it("keeps a folder whose tree is not the one it was given, and pushes nothing", async () => {
		const store = await seeded();
		const before = await store.folders();
		await store.add([check("c")]);
		const tip = remote.tip();
		expect(await store.retire(new Map([[changeset, before.get(changeset)!]]))).toEqual(
			retirement({ changed: [changeset] }),
		);
		expect(remote.tip()).toBe(tip);
	});

	it("reports a changeset with no folder at the tip as absent, and pushes nothing", async () => {
		const store = await seeded();
		const tip = remote.tip();
		expect(await store.retire(new Map([[third, treeOf(changeset)]]))).toEqual(retirement({ absent: [third] }));
		expect(remote.tip()).toBe(tip);
	});

	it("reports every changeset absent on a branch that does not exist, and creates none", async () => {
		const store = await remote.open();
		expect(await store.retire(new Map([[changeset, emptyTree]]))).toEqual(retirement({ absent: [changeset] }));
		expect(remote.tip()).toBeUndefined();
	});

	it("does nothing for an empty map", async () => {
		const store = await seeded();
		const tip = remote.tip();
		const without = vi.spyOn(RecordRepository.prototype, "withoutFolders");
		expect(await store.retire(new Map())).toEqual(retirement({}));
		expect(without).not.toHaveBeenCalled();
		expect(remote.tip()).toBe(tip);
	});

	it("refuses folders and retire as closed on a closed handle", async () => {
		const store = await seeded();
		await store.close();
		const closed = { code: "closed", message: "the record store is closed" };
		await expect(store.folders()).rejects.toMatchObject(closed);
		await expect(store.retire(new Map([[changeset, treeOf(changeset)]]))).rejects.toMatchObject(closed);
	});
});

describe("the folders at the tip", { timeout: 300_000 }, () => {
	it("names each folder with its tree's object ID, a disposed one included", async () => {
		const store = await seeded();
		await store.add([check("x", third)]);
		await store.dispose(third);
		const found = await store.folders();
		expect(found).toEqual(new Map([changeset, other, third].map((name) => [name, treeOf(name)])));
	});

	it("reads no blob and no size", async () => {
		const store = await seeded();
		const sizes = vi.spyOn(RecordRepository.prototype, "sizes");
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		expect((await store.folders()).size).toBe(2);
		expect(sizes).not.toHaveBeenCalled();
		expect(blobs).not.toHaveBeenCalled();
	});

	it("answers on a tip one entry past the entry limit", async () => {
		const store = await seeded();
		remote.plant(roots(limit + 1));
		expect(await store.folders()).toEqual(new Map([changeset, other].map((name) => [name, treeOf(name)])));
	});

	it("names a folder that holds a stray", async () => {
		const store = await seeded();
		remote.plant({ [`changesets/${changeset}/notes.txt`]: { bytes: "notes" } });
		expect((await store.folders()).get(changeset)).toBe(treeOf(changeset));
	});

	it("gives an empty map when the branch does not exist", async () => {
		const store = await remote.open();
		expect(await store.folders()).toEqual(new Map());
	});

	it("gives an empty map when the tip holds no `changesets` tree", async () => {
		const store = await remote.open();
		remote.plant({ "notes.txt": { bytes: "root" } });
		expect(await store.folders()).toEqual(new Map());
	});
});

describe("what a retire keeps", { timeout: 60_000 }, () => {
	// Rule 3 of the shared record decision: no record carries an incarnation, so a changeset with a cell or a disposal is never recreated.
	it("keeps a folder that holds a cell, reports it as kept, and retires a record-only folder beside it", async () => {
		const store = await seeded();
		await store.writeCell(changeset, undefined, '"lease"');
		const paths = under(changeset);
		expect(paths).toContain(cellPath(changeset));
		expect(await store.retire(await store.folders())).toEqual(retirement({ removed: [other], kept: [changeset] }));
		expect(under(changeset)).toEqual(paths);
		expect(under(other)).toEqual([]);
		expect((await store.readCell(changeset)).value).toBe('"lease"');
	});

	it("keeps a disposed folder, reports it as kept, and its mark still refuses an add", async () => {
		const store = await seeded();
		await store.dispose(changeset);
		const paths = under(changeset);
		expect(await store.retire(await store.folders())).toEqual(retirement({ removed: [other], kept: [changeset] }));
		expect(under(changeset)).toEqual(paths);
		await expect(store.add([check("late")])).rejects.toMatchObject({ code: "disposed" });
	});

	it("retires a record-only folder whole, so a later add starts it afresh", async () => {
		const store = await seeded();
		expect(await store.retire(new Map([[changeset, treeOf(changeset)]]))).toEqual(
			retirement({ removed: [changeset] }),
		);
		expect(under(changeset)).toEqual([]);
		await store.add([check("late")]);
		expect(keys(await store.list(changeset))).toEqual(["late"]);
	});

	it("reports a folder that holds a cell and a stray as holding a stray", async () => {
		const store = await seeded();
		await store.writeCell(changeset, undefined, '"lease"');
		remote.plant({ [`changesets/${changeset}/notes.txt`]: { bytes: "notes" } });
		expect(await store.retire(new Map([[changeset, treeOf(changeset)]]))).toEqual(
			retirement({ strays: [changeset] }),
		);
	});
});

// The store's own repository and the tip it fetched, for calls the store makes only on a tip past a limit.
async function opened(store: GitRecordStore): Promise<{ repository: RecordRepository; tip: string }> {
	const fetch = vi.spyOn(RecordRepository.prototype, "fetch");
	await store.folders();
	const repository = fetch.mock.contexts[0] as RecordRepository;
	fetch.mockRestore();
	return { repository, tip: remote.tip()! };
}

const deadline = () => Deadline.after(systemClock, 30_000);

// `children` answers undefined, as for a listing past its bytes, for `treeish` alone.
function pastBytes(treeish: string) {
	const children = RecordRepository.prototype.children;
	return vi.spyOn(RecordRepository.prototype, "children").mockImplementation(async function (
		this: RecordRepository,
		asked,
		time,
		maxBytes,
	) {
		return asked === treeish ? undefined : children.call(this, asked, time, maxBytes);
	});
}

describe("what a retire is given", { timeout: 60_000 }, () => {
	it("refuses a name that is no changeset's before it reads the branch", async () => {
		const store = await seeded();
		const fetch = vi.spyOn(RecordRepository.prototype, "fetch");
		await expect(store.retire(new Map([["../changesets", emptyTree]]))).rejects.toMatchObject({
			code: "invalidChangeset",
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("the folders a retire reads", { timeout: 60_000 }, () => {
	it("reads only trees named as changesets inside `changesets`, and keeps every other entry when it retires them", async () => {
		const store = await seeded();
		remote.plant({
			README: { bytes: "root" },
			"a/x.json": { bytes: "{}" },
			[`changesets/${third}`]: { bytes: "a file named as a changeset" },
			"changesets/Not_A_Name/x.json": { bytes: "{}" },
		});
		const seen = await store.folders();
		expect([...seen.keys()].sort()).toEqual([changeset, other].sort());
		expect(sorted(await store.retire(seen))).toEqual(retirement({ removed: [changeset, other].sort() }));
		expect(remote.files()).toEqual(["README", "a/x.json", "changesets/Not_A_Name/x.json", `changesets/${third}`]);
	});

	it("reads no folders from a `changesets` that is a file", async () => {
		const store = await remote.open();
		remote.plant({ changesets: { bytes: "not a folder" } });
		expect(await store.folders()).toEqual(new Map());
	});

	it("refuses a tip whose top level lists past its bytes", async () => {
		const store = await seeded();
		const tip = remote.tip()!;
		pastBytes(tip);
		await expect(store.folders()).rejects.toMatchObject({
			code: "unreachable",
			message: `one level of ${tip} lists more than ${listingLimit} bytes`,
		});
	});
});

describe("the commit a retire builds", { timeout: 60_000 }, () => {
	it("names every changeset it would have retired when the rule refuses the commit", async () => {
		const store = await seeded();
		const seen = await store.folders();
		vi.spyOn(StateTree, "removesOnly").mockResolvedValueOnce(false);
		await expect(
			store.retire(
				new Map([
					[changeset, seen.get(changeset)!],
					[other, seen.get(other)!],
				]),
			),
		).rejects.toMatchObject({
			code: "unreachable",
			message: `the commit retiring ${changeset}, ${other} changes more of ${remote.branch} than it removes; nothing was pushed`,
		});
	});

	it("refuses a parent whose `changesets` is a file", async () => {
		const store = await seeded();
		const { repository } = await opened(store);
		const time = deadline();
		const file = await blob(repository, "not a tree", time);
		const parent = await commitOf(
			repository,
			await mktree(repository, [`100644 blob ${file}\tchangesets`], time),
			[],
			time,
		);
		await expect(repository.withoutFolders(parent, [changeset], time)).rejects.toMatchObject({
			code: "unreachable",
			message: `${parent} holds no changesets folder in ${repository.path}`,
		});
	});

	it("refuses a parent whose top level lists past its bytes", async () => {
		const store = await seeded();
		const { repository, tip } = await opened(store);
		pastBytes(tip);
		await expect(repository.withoutFolders(tip, [changeset], deadline())).rejects.toMatchObject({
			code: "unreachable",
			message: `listing ${tip} ran past ${listingLimit} bytes in ${repository.path}`,
		});
	});
});

describe("the removal-only rule's own reads", { timeout: 60_000 }, () => {
	// The commit removes `changeset` and keeps `other`, so every listing the rule makes has an answer to lose.
	async function removal() {
		const store = await seeded();
		const { repository, tip } = await opened(store);
		const commit = await repository.withoutFolders(tip, [changeset], deadline());
		expect(await StateTree.removesOnly(repository, tip, commit, deadline())).toBe(true);
		return { repository, tip, commit };
	}

	it("refuses a removal-only tree on a commit whose one parent is not the tip", async () => {
		await refuses(async (repository, parent, deadline) => {
			const removed = await repository.commit(parent, removals(changeset), deadline);
			const tree = await plumb(repository, ["rev-parse", `${removed}^{tree}`], deadline);
			const aside = await commitOf(
				repository,
				await plumb(repository, ["rev-parse", `${parent}^{tree}`], deadline),
				[],
				deadline,
			);
			return commitOf(repository, tree, [aside], deadline);
		});
	});

	for (const listing of ["parent", "commit", "parent's changesets", "commit's changesets"] as const) {
		it(`refuses a removal when the ${listing} listing runs past its bytes`, async () => {
			const { repository, tip, commit } = await removal();
			const oids = {
				parent: tip,
				commit,
				"parent's changesets": await plumb(repository, ["rev-parse", `${tip}:changesets`], deadline()),
				"commit's changesets": await plumb(repository, ["rev-parse", `${commit}:changesets`], deadline()),
			};
			pastBytes(oids[listing]);
			expect(await StateTree.removesOnly(repository, tip, commit, deadline())).toBe(false);
		});
	}

	it("refuses a parent that holds no `changesets` tree", async () => {
		const store = await seeded();
		const { repository } = await opened(store);
		const time = deadline();
		const file = await blob(repository, "root", time);
		const parent = await commitOf(
			repository,
			await mktree(repository, [`100644 blob ${file}\tnotes.txt`], time),
			[],
			time,
		);
		const commit = await commitOf(
			repository,
			await plumb(repository, ["rev-parse", `${parent}^{tree}`], time),
			[parent],
			time,
		);
		expect(await StateTree.removesOnly(repository, parent, commit, time)).toBe(false);
	});
});

describe("a folder too large to judge", { timeout: 120_000 }, () => {
	// `entries` lists the folder at `oid` padded with copies of its first entry to `count`, and answers others as git does.
	function listed(oid: string, count: number | undefined) {
		const entries = RecordRepository.prototype.entries;
		return vi.spyOn(RecordRepository.prototype, "entries").mockImplementation(async function (
			this: RecordRepository,
			asked,
			time,
			maxBytes,
		) {
			const real = await entries.call(this, asked, time, maxBytes);
			if (asked !== oid) return real;
			if (count === undefined) return undefined;
			return [...real!, ...Array.from({ length: count - real!.length }, () => real![0]!)];
		});
	}

	// `sizes` answers git's sizes, with `size` for every blob or for the blob of `only`, or none for it with `undefined`.
	function sized(size: number | undefined, only?: string) {
		const sizes = RecordRepository.prototype.sizes;
		return vi.spyOn(RecordRepository.prototype, "sizes").mockImplementation(async function (
			this: RecordRepository,
			oids,
			time,
		) {
			const real = await sizes.call(this, oids, time);
			for (const oid of oids) {
				if (only !== undefined && oid !== only) continue;
				if (size === undefined) real.delete(oid);
				else real.set(oid, size);
			}
			return real;
		});
	}

	async function retiring(store: GitRecordStore): Promise<Retirement> {
		return store.retire(new Map([[changeset, (await store.folders()).get(changeset)!]]));
	}

	it("keeps a folder whose listing runs past its bytes", async () => {
		const store = await seeded();
		listed(treeOf(changeset), undefined);
		expect(await retiring(store)).toEqual(retirement({ strays: [changeset] }));
	});

	it("removes a folder of exactly the entry limit, and keeps one an entry past it", async () => {
		const store = await seeded();
		const spy = listed(treeOf(changeset), entryLimit + 1);
		expect(await retiring(store)).toEqual(retirement({ strays: [changeset] }));
		spy.mockRestore();
		listed(treeOf(changeset), entryLimit);
		expect(await retiring(store)).toEqual(retirement({ removed: [changeset] }));
	});

	it("keeps a folder holding one record a byte past the record limit, or one git gives no size for", async () => {
		const store = await seeded();
		const record = remote.git(["rev-parse", `refs/heads/${remote.branch}:${filed(check("a")).path}`]);
		const past = sized(recordLimit + 1, record);
		expect(await retiring(store)).toEqual(retirement({ strays: [changeset] }));
		past.mockRestore();
		sized(undefined, record);
		expect(await retiring(store)).toEqual(retirement({ strays: [changeset] }));
	});

	it("removes a folder whose records total exactly the tip's byte limit, and keeps one a record past it", async () => {
		const store = await seeded();
		const whole = tipLimit / recordLimit;
		await store.add([
			...Array.from({ length: whole - under(changeset).length }, (_, n) => check(`t${n}`)),
			...Array.from({ length: whole + 1 - under(other).length }, (_, n) => check(`t${n}`, other)),
		]);
		expect([under(changeset).length, under(other).length]).toEqual([whole, whole + 1]);
		sized(recordLimit);
		expect(sorted(await store.retire(await store.folders()))).toEqual(
			retirement({ removed: [changeset], strays: [other] }),
		);
	});
});

describe("a `changesets` level that lists a name twice", { timeout: 60_000 }, () => {
	// Rewrites the tip by hand so that `changesets` lists `changeset` twice: first `first`, then its clean folder. git
	// mktree writes such a tree, and a remote that runs no fsck takes it.
	function twice(first: "stray" | "blob"): { clean: string; tip: string } {
		const clean = treeOf(changeset);
		const junk = remote.git(["hash-object", "-w", "--stdin"], remote.path, { input: "junk" });
		const copy =
			first === "blob"
				? `100644 blob ${junk}\t${changeset}`
				: `040000 tree ${remote.git(["mktree"], remote.path, {
						input: `${remote.git(["ls-tree", clean])}\n100644 blob ${junk}\tjunk.txt\n`,
					})}\t${changeset}`;
		const tip = remote.tip()!;
		const folders = remote
			.git(["ls-tree", `${tip}:changesets`])
			.split("\n")
			.flatMap((line) => (line.endsWith(`\t${changeset}`) ? [copy, line] : [line]));
		const inner = remote.git(["mktree"], remote.path, { input: `${folders.join("\n")}\n` });
		const root = remote
			.git(["ls-tree", tip])
			.split("\n")
			.map((line) => (line.endsWith("\tchangesets") ? `040000 tree ${inner}\tchangesets` : line));
		const tree = remote.git(["mktree"], remote.path, { input: `${root.join("\n")}\n` });
		const commit = remote.git(["commit-tree", tree, "-p", tip, "-m", "planted"]);
		remote.git(["update-ref", `refs/heads/${remote.branch}`, commit]);
		return { clean, tip: commit };
	}

	for (const first of ["stray", "blob"] as const) {
		it(`reads no folder for the name, and keeps both entries, when the first is a ${first}`, async () => {
			const store = await seeded();
			const { clean, tip } = twice(first);
			const seen = await store.folders();
			expect([...seen.keys()]).toEqual([other]);
			expect(await store.retire(new Map([[changeset, clean]]))).toEqual(retirement({ absent: [changeset] }));
			expect(remote.tip()).toBe(tip);
		});
	}

	it("refuses a commit that removes a name its parent lists twice", async () => {
		const store = await seeded();
		const { tip } = twice("stray");
		const { repository } = await opened(store);
		const commit = await repository.withoutFolders(tip, [changeset], deadline());
		expect(await StateTree.removesOnly(repository, tip, commit, deadline())).toBe(false);
	});
});

describe("what the removal-only rule lets a commit remove", { timeout: 60_000 }, () => {
	for (const [what, path] of [
		["a file named as a changeset", `changesets/${third}`],
		["a folder named as no changeset", "changesets/Not_A_Name/x.json"],
	] as const) {
		it(`refuses a commit that removes ${what}, which is a stray`, async () => {
			const store = await seeded();
			remote.plant({ [path]: { bytes: "{}" } });
			const { repository, tip } = await opened(store);
			const commit = await repository.commit(tip, [{ path, bytes: null }], deadline());
			expect(await StateTree.removesOnly(repository, tip, commit, deadline())).toBe(false);
		});
	}
});

describe("what one retire may judge", { timeout: 300_000 }, () => {
	// `entries` lists the folder at `oid` padded with copies of its first entry to `count`, and answers others as git does.
	function padded(oid: string, count: number) {
		const entries = RecordRepository.prototype.entries;
		return vi.spyOn(RecordRepository.prototype, "entries").mockImplementation(async function (
			this: RecordRepository,
			asked,
			time,
			maxBytes,
		) {
			const real = await entries.call(this, asked, time, maxBytes);
			if (asked !== oid) return real;
			return [...real!, ...Array.from({ length: count - real!.length }, () => real![0]!)];
		});
	}

	// Every blob's size reads as the record limit, so a folder of `n` records weighs `n` record limits.
	function heavy() {
		const sizes = RecordRepository.prototype.sizes;
		return vi.spyOn(RecordRepository.prototype, "sizes").mockImplementation(async function (
			this: RecordRepository,
			oids,
			time,
		) {
			const real = await sizes.call(this, oids, time);
			for (const oid of oids) real.set(oid, recordLimit);
			return real;
		});
	}

	// Fills each named changeset's folder to `count` files, its cell included.
	async function fill(store: GitRecordStore, counts: Readonly<Record<string, number>>) {
		await store.add(
			Object.entries(counts).flatMap(([name, count]) =>
				Array.from({ length: count - under(name).length }, (_, n) => check(`f${n}`, name)),
			),
		);
		expect(Object.keys(counts).map((name) => under(name).length)).toEqual(Object.values(counts));
	}

	function both(seen: ReadonlyMap<string, string>): Map<string, string> {
		return new Map([
			[changeset, seen.get(changeset)!],
			[other, seen.get(other)!],
		]);
	}

	it("judges folders that together list exactly the entry limit, and defers the one that passes it", async () => {
		const store = await seeded();
		const seen = await store.folders();
		const spy = padded(treeOf(changeset), entryLimit - under(other).length);
		expect(await store.retire(both(seen))).toEqual(retirement({ removed: [changeset, other] }));
		spy.mockRestore();
		await seeded();
		const again = await store.folders();
		padded(treeOf(changeset), entryLimit - under(other).length + 1);
		const found = await store.retire(both(again));
		expect(under(other)).toHaveLength(1);
		expect(found).toEqual(retirement({ removed: [changeset], deferred: [other] }));
	});

	it("judges folders whose records together total exactly the byte limit, and defers the one that passes it", async () => {
		const store = await seeded();
		const half = tipLimit / recordLimit / 2;
		await fill(store, { [changeset]: half, [other]: half });
		const weighed = heavy();
		expect(await store.retire(both(await store.folders()))).toEqual(retirement({ removed: [changeset, other] }));
		weighed.mockRestore();
		await fill(store, { [changeset]: half, [other]: half + 1 });
		heavy();
		const found = await store.retire(both(await store.folders()));
		expect(under(other)).toHaveLength(half + 1);
		expect(found).toEqual(retirement({ removed: [changeset], deferred: [other] }));
	});

	it("on a tip far past the byte limit, retires what fits and defers the rest without reading their records", async () => {
		const store = await seeded();
		const most = (tipLimit / recordLimit) * 0.625;
		await fill(store, { [changeset]: most, [other]: most, [third]: most });
		const seen = await store.folders();
		heavy();
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		const entries = vi.spyOn(RecordRepository.prototype, "entries");
		const kept = new Set([...under(other), ...under(third)].map((path) => remote.oid(path)));
		const found = await store.retire(seen);
		const read = blobs.mock.calls.flatMap(([wanted]) => [...wanted.keys()]);
		expect(read.filter((oid) => kept.has(oid))).toEqual([]);
		expect(entries.mock.calls.map(([oid]) => oid)).not.toContain(treeOf(other));
		expect(under(changeset)).toEqual([]);
		expect(found).toEqual(retirement({ removed: [changeset], deferred: [third, other] }));
		expect(
			await store.retire(
				new Map([
					[other, treeOf(other)],
					[third, treeOf(third)],
				]),
			),
		).toEqual(retirement({ removed: [other], deferred: [third] }));
	});

	it("keeps no judgement past the call, so a read after it reads the folder's records again", async () => {
		await seeded();
		remote.plant({ [`changesets/${changeset}/junk.txt`]: { bytes: "junk" } });
		const store = await remote.open();
		const seen = await store.folders();
		const found = await store.retire(new Map([[changeset, seen.get(changeset)!]]));
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		await store.strays();
		const read = blobs.mock.calls.flatMap(([wanted]) => [...wanted.keys()]);
		expect(read).toContain(remote.oid(filed(check("a")).path));
		expect(found).toEqual(retirement({ strays: [changeset] }));
	});
});
