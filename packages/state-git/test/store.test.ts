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
		expect(blobs.mock.calls.flatMap(([oids]) => oids)).toHaveLength(2);
		blobs.mockClear();
		expect(keys(await reader.list(changeset))).toEqual(["a", "b"]);
		expect(blobs.mock.calls.flatMap(([oids]) => oids)).toEqual([]);
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
