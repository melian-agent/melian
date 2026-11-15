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
			message: `melian/state holds ${limit + 1} entries at its tip, past the store's limit of ${limit}; disposing changesets or removing strays brings it under`,
		});
		expect(sizes).not.toHaveBeenCalled();
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
			message: `melian/state lists more than ${listingLimit} bytes of entries at its tip, past the store's limit; disposing changesets or removing strays brings it under`,
		});
		expect(sizes).not.toHaveBeenCalled();
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
			message: `melian/state holds ${limit + 1} bytes of records and cells at its tip, past the store's limit of ${limit}; disposing changesets brings it under`,
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
