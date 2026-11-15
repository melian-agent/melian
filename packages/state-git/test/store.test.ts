import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordRepository } from "../src/repository.ts";
import { cellPath } from "../src/state-tree.ts";
import { changeset, check, filed, keys, other, Remote } from "./fixtures/remote.ts";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await remote.close();
});

describe("a closed handle", { timeout: 60_000 }, () => {
	it("refuses every call as closed", async () => {
		const store = await remote.open();
		await store.add([check("a")]);
		await store.close();
		const closed = { code: "closed" };
		await expect(store.strays()).rejects.toMatchObject(closed);
		await expect(store.add([check("b")])).rejects.toMatchObject(closed);
		await expect(store.list(changeset)).rejects.toMatchObject(closed);
		await expect(store.readCell(changeset)).rejects.toMatchObject(closed);
		await expect(store.writeCell(changeset, undefined, '"x"')).rejects.toMatchObject(closed);
		await expect(store.dispose(changeset)).rejects.toMatchObject(closed);
	});
});

describe("the branch it is given", { timeout: 60_000 }, () => {
	it("keeps its records there, and neither reads nor writes melian/state", async () => {
		await (await remote.open()).add([check("a")]);
		const state = remote.tip();
		const trial = await remote.open({ branch: "melian/trial" });
		await trial.add([check("b")]);
		expect(keys(await trial.list(changeset))).toEqual(["b"]);
		expect(remote.tip()).toBe(state);
		expect(remote.tip("melian/trial")).toBeDefined();
	});
});

describe("writes that change nothing", { timeout: 60_000 }, () => {
	it("adds no records without reaching the remote", async () => {
		const store = await remote.open({ remote: `file://${join(remote.root, "absent.git")}` });
		await expect(store.add([])).resolves.toBeUndefined();
	});

	it("pushes no commit for a record the branch already holds", async () => {
		const store = await remote.open();
		await store.add([check("a")]);
		const tip = remote.tip();
		const push = vi.spyOn(RecordRepository.prototype, "push");
		await store.add([check("a")]);
		expect(push).not.toHaveBeenCalled();
		expect(remote.tip()).toBe(tip);
	});
});

describe("a disposed changeset", { timeout: 60_000 }, () => {
	it("keeps only its mark on the branch", async () => {
		const store = await remote.open();
		await store.add([check("a"), check("b"), check("kept", other)]);
		await store.dispose(changeset);
		expect(remote.files().filter((path) => path.startsWith(`changesets/${changeset}/`))).toEqual([
			cellPath(changeset),
		]);
	});

	it("lists nothing, even when a record is planted beside its mark", async () => {
		const store = await remote.open();
		await store.dispose(changeset);
		const planted = filed(check("late"));
		remote.plant({ [planted.path]: { bytes: planted.bytes } });
		expect(await store.list(changeset)).toEqual([]);
	});
});

describe("reading the tree", { timeout: 60_000 }, () => {
	it("reads each blob once per handle", async () => {
		const store = await remote.open();
		await store.add([check("a"), check("b")]);
		const reader = await remote.open();
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		expect(keys(await reader.list(changeset))).toEqual(["a", "b"]);
		expect(blobs.mock.calls.flatMap(([sizes]) => [...sizes.keys()])).toHaveLength(2);
		blobs.mockClear();
		expect(keys(await reader.list(changeset))).toEqual(["a", "b"]);
		expect(blobs.mock.calls.flatMap(([sizes]) => [...sizes.keys()])).toEqual([]);
	});
});

describe("the entries a tip may hold", { timeout: 300_000 }, () => {
	const limit = 65_536;
	const listingLimit = 64 * 1024 * 1024;
	// Strays, which `strays()` lists and never refuses, each a path of `length` bytes holding an empty file.
	const strays = (count: number, length = 0) =>
		Object.fromEntries(
			Array.from({ length: count }, (_, n) => [`noise/${n}`.padEnd(length, "x"), { bytes: "" }] as const),
		);
	// The length of the path that makes one line of `git ls-tree -r -z` a KiB: mode, type, object ID, tab and NUL.
	const kibPath = 1024 - "100644 blob ".length - 40 - 2;

	it("lists a tip of exactly the limit's entries", async () => {
		const store = await remote.open();
		remote.plant(strays(limit));
		expect(await store.strays()).toHaveLength(limit);
	});

	it("fails as unreachable one entry past the limit, naming the branch, the count and the limit, and reads no sizes", async () => {
		const store = await remote.open();
		remote.plant(strays(limit + 1));
		const sizes = vi.spyOn(RecordRepository.prototype, "sizes");
		await expect(store.strays()).rejects.toMatchObject({
			code: "unreachable",
			message: `melian/state holds ${limit + 1} entries at its tip, past the store's limit of ${limit}; every call fails, dispose included, until a writer removes changesets or strays from the branch with git`,
		});
		expect(sizes).not.toHaveBeenCalled();
	});

	it("fails a dispose one entry past the limit, as it fails every call", async () => {
		const store = await remote.open();
		remote.plant(strays(limit + 1));
		await expect(store.dispose(changeset)).rejects.toMatchObject({
			code: "unreachable",
			message: `melian/state holds ${limit + 1} entries at its tip, past the store's limit of ${limit}; every call fails, dispose included, until a writer removes changesets or strays from the branch with git`,
		});
	});

	it("lists a tip whose listing is exactly its cap", async () => {
		const store = await remote.open();
		remote.plant(strays(limit, kibPath));
		expect(await store.strays()).toHaveLength(limit);
	});

	it("fails as unreachable when the listing runs one byte past its cap, naming the branch and the cap, and reads no sizes", async () => {
		const store = await remote.open();
		remote.plant({ ...strays(limit - 1, kibPath), [`long/`.padEnd(kibPath + 1, "x")]: { bytes: "" } });
		const sizes = vi.spyOn(RecordRepository.prototype, "sizes");
		await expect(store.strays()).rejects.toMatchObject({
			code: "unreachable",
			message: `melian/state lists more than ${listingLimit} bytes of entries at its tip, past the store's limit; every call fails, dispose included, until a writer removes changesets or strays from the branch with git`,
		});
		expect(sizes).not.toHaveBeenCalled();
	});
});

describe("the entries a write may leave", { timeout: 300_000 }, () => {
	const limit = 65_536;
	// Strays inside another changeset's folder, which refuse only that changeset.
	const strays = (count: number) =>
		Object.fromEntries(
			Array.from({ length: count }, (_, n) => [`changesets/${other}/noise/${n}`, { bytes: "" }] as const),
		);

	it("pushes a write that leaves the tip exactly at the limit, and disposes there", async () => {
		const store = await remote.open();
		remote.plant(strays(limit - 1));
		await store.add([check("a")]);
		expect(keys(await store.list(changeset))).toEqual(["a"]);
		await store.dispose(changeset);
		expect(await store.list(changeset)).toEqual([]);
	});

	it("fails as unreachable a write that would leave one entry past the limit, and pushes nothing", async () => {
		const store = await remote.open();
		remote.plant(strays(limit));
		const tip = remote.tip();
		await expect(store.add([check("a")])).rejects.toMatchObject({
			code: "unreachable",
			message: `melian/state would hold ${limit + 1} entries at its tip, past the store's limit of ${limit}; nothing was pushed, and disposing changesets or removing strays makes room`,
		});
		expect(remote.tip()).toBe(tip);
	});

	it("measures again the commit it rebuilds after losing a race, and refuses it", async () => {
		const first = await remote.open();
		const second = await remote.open();
		remote.plant(strays(limit - 2));
		const push = RecordRepository.prototype.push;
		let raced = false;
		const pushes = vi.spyOn(RecordRepository.prototype, "push").mockImplementation(async function (
			this: RecordRepository,
			...args
		) {
			if (!raced) {
				raced = true;
				await first.add([check("a"), check("b")]);
			}
			return push.apply(this, args);
		});
		await expect(second.add([check("c"), check("d")])).rejects.toMatchObject({
			code: "unreachable",
			message: `melian/state would hold ${limit + 2} entries at its tip, past the store's limit of ${limit}; nothing was pushed, and disposing changesets or removing strays makes room`,
		});
		expect(pushes).toHaveBeenCalledTimes(2);
		expect(keys(await first.list(changeset))).toEqual(["a", "b"]);
	});
});

describe("the bytes a tip may hold", { timeout: 60_000 }, () => {
	const limit = 256 * 1024 * 1024;
	const fileLimit = 4 * 1024 * 1024;

	// Reports the blobs it is asked about as `total` bytes in all, raising each, but none past what one file may be.
	function reportTotal(total: number) {
		const sizes = RecordRepository.prototype.sizes;
		return vi.spyOn(RecordRepository.prototype, "sizes").mockImplementation(async function (
			this: RecordRepository,
			...args
		) {
			const found = await sizes.apply(this, args);
			let left = total - [...found.values()].reduce((sum, size) => sum + size, 0);
			for (const [oid, size] of found) {
				const more = Math.min(fileLimit - size, left);
				found.set(oid, size + more);
				left -= more;
			}
			expect(left).toBe(0);
			return found;
		});
	}

	async function reader() {
		await (await remote.open()).add(Array.from({ length: 65 }, (_, n) => check(`r${n}`)));
		return remote.open();
	}

	it("reads a tip whose records and cells total the limit", async () => {
		const store = await reader();
		reportTotal(limit);
		expect(await store.list(changeset)).toHaveLength(65);
	});

	it("fails as unreachable one byte past the limit, naming the branch, the total and the limit, and reads nothing", async () => {
		const store = await reader();
		reportTotal(limit + 1);
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		await expect(store.list(changeset)).rejects.toMatchObject({
			code: "unreachable",
			message: `melian/state holds ${limit + 1} bytes of records and cells at its tip, past the store's limit of ${limit}; every call fails, dispose included, until a writer removes changesets from the branch with git`,
		});
		expect(blobs).not.toHaveBeenCalled();
	});

	// A tip of `count` records, with git reporting every blob at what one file may be, so 64 of them total the limit.
	async function fullFiles(count: number) {
		await (await remote.open()).add(Array.from({ length: count }, (_, n) => check(`r${n}`)));
		vi.spyOn(RecordRepository.prototype, "sizes").mockImplementation(
			async (oids) => new Map(oids.map((oid) => [oid, fileLimit])),
		);
		return remote.open();
	}

	it("pushes a write that leaves the tip exactly at the limit, and disposes there", async () => {
		const store = await fullFiles(63);
		await store.add([check("x")]);
		expect(await store.list(changeset)).toHaveLength(64);
		await store.dispose(changeset);
		expect(await store.list(changeset)).toEqual([]);
	});

	it("fails as unreachable a write that would leave the tip past the limit, and pushes nothing", async () => {
		const store = await fullFiles(64);
		const tip = remote.tip();
		await expect(store.add([check("x")])).rejects.toMatchObject({
			code: "unreachable",
			message: `melian/state would hold ${65 * fileLimit} bytes of records and cells at its tip, past the store's limit of ${limit}; nothing was pushed, and disposing changesets makes room`,
		});
		expect(remote.tip()).toBe(tip);
	});

	// One cell's bytes at `count` changesets' paths, with git reporting every blob at what one file may be.
	async function sharedCell(count: number) {
		const writer = await remote.open();
		await writer.writeCell(changeset, undefined, '"x"');
		const bytes = remote.git(["cat-file", "blob", remote.oid(cellPath(changeset))]);
		remote.plant({
			[cellPath(changeset)]: null,
			...Object.fromEntries(
				Array.from({ length: count }, (_, n) => [cellPath(`pull-${n.toString(16).padStart(16, "0")}`), { bytes }]),
			),
		});
		vi.spyOn(RecordRepository.prototype, "sizes").mockImplementation(
			async (oids) => new Map(oids.map((oid) => [oid, fileLimit])),
		);
		return remote.open();
	}

	it("counts a blob at every path it sits at, and reads a tip of one cell at 64 paths, the limit", async () => {
		const store = await sharedCell(64);
		expect(await store.strays()).toEqual([]);
	});

	it("fails as unreachable when one cell sits at 65 paths, past the limit, and reads nothing", async () => {
		const store = await sharedCell(65);
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		await expect(store.strays()).rejects.toMatchObject({
			code: "unreachable",
			message: `melian/state holds ${65 * fileLimit} bytes of records and cells at its tip, past the store's limit of ${limit}; every call fails, dispose included, until a writer removes changesets from the branch with git`,
		});
		expect(blobs).not.toHaveBeenCalled();
	});

	it("fails as unreachable when git gives more bytes than the sizes it reported", async () => {
		const store = await reader();
		const sizes = RecordRepository.prototype.sizes;
		vi.spyOn(RecordRepository.prototype, "sizes").mockImplementation(async function (
			this: RecordRepository,
			...args
		) {
			const found = await sizes.apply(this, args);
			const [oid, size] = [...found][0]!;
			found.set(oid, size - 1);
			return found;
		});
		await expect(store.list(changeset)).rejects.toMatchObject({
			code: "unreachable",
			message: expect.stringMatching(/^reading blobs in \S+ gave more bytes than their sizes$/),
		});
	});
});

describe("the strays it names", { timeout: 60_000 }, () => {
	it("are every file it did not write, outside and inside a changeset's folder", async () => {
		const store = await remote.open();
		await store.add([check("a")]);
		remote.plant({ "notes.txt": { bytes: "x" }, [`changesets/${changeset}/notes.txt`]: { bytes: "y" } });
		expect(await store.strays()).toEqual(["notes.txt", `changesets/${changeset}/notes.txt`]);
	});
});

describe("the system clock", { timeout: 60_000 }, () => {
	it("waits on a timer for the time a lost race draws", async () => {
		const store = await remote.open();
		await store.add([check("first")]);
		const push = RecordRepository.prototype.push;
		let lost = false;
		vi.spyOn(RecordRepository.prototype, "push").mockImplementation(async function (this: RecordRepository, ...args) {
			if (!lost) {
				lost = true;
				remote.plant({ "changesets/other-writer/cell.json": null });
			}
			return push.apply(this, args);
		});
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const timer = vi.spyOn(globalThis, "setTimeout");
		await store.add([check("second")]);
		expect(timer.mock.calls.map((call) => call[1])).toContain(25);
	});
});
