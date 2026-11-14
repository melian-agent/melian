import { RecordError, type RecordStore } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordRepository } from "../src/repository.ts";
import { fileLimit } from "../src/state-tree.ts";
import { changeset, check, filed, keys, other, type Planted, Remote } from "./fixtures/remote.ts";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await remote.close();
});

function refusal(path: string) {
	return (error: unknown) => {
		expect(error).toBeInstanceOf(RecordError);
		expect((error as RecordError).code).toBe("unknownFile");
		expect((error as RecordError).path).toBe(path);
		return true;
	};
}

async function refusesEveryCall(store: RecordStore, name: string, path: string): Promise<void> {
	await expect(store.list(name)).rejects.toSatisfy(refusal(path));
	await expect(store.add([check("late", name)])).rejects.toSatisfy(refusal(path));
	await expect(store.readCell(name)).rejects.toSatisfy(refusal(path));
	await expect(store.writeCell(name, undefined, '"lease"')).rejects.toSatisfy(refusal(path));
	await expect(store.dispose(name)).rejects.toSatisfy(refusal(path));
}

// A store holding a record in each of two changesets, with `entries` planted beside them by hand.
async function plantedBeside(entries: Readonly<Record<string, Planted>>): Promise<RecordStore> {
	const store = await remote.open();
	await store.add([check("kept"), check("kept", other)]);
	remote.plant(entries);
	return store;
}

describe("a stray entry inside one changeset's folder", { timeout: 60_000 }, () => {
	const strays: Readonly<Record<string, Planted>> = {
		"a file of another name": { bytes: "notes" },
		"a link at the cell's path": { bytes: "/etc/passwd", mode: "120000" },
		"an executable cell": {
			bytes: '{"v":1,"value":"1","version":"00000000-0000-4000-8000-000000000000"}',
			mode: "100755",
		},
		"a cell with another field": {
			bytes: '{"v":1,"value":"1","version":"00000000-0000-4000-8000-000000000000","by":"x"}',
		},
		"a cell whose version is no random UUID": { bytes: '{"v":1,"value":"1","version":"7"}' },
		"a cell whose bytes are not the ones Melian writes": {
			bytes: '{"value":"1","v":1,"version":"00000000-0000-4000-8000-000000000000"}',
		},
		"a cell whose value is not JSON": {
			bytes: '{"v":1,"value":"x","version":"00000000-0000-4000-8000-000000000000"}',
		},
		"a cell whose version has more before its UUID": {
			bytes: '{"v":1,"value":"1","version":"x00000000-0000-4000-8000-000000000000"}',
		},
		"a cell whose version has more after its UUID": {
			bytes: '{"v":1,"value":"1","version":"00000000-0000-4000-8000-000000000000x"}',
		},
		"a cell whose version is a list": {
			bytes: '{"v":1,"value":"1","version":["00000000-0000-4000-8000-000000000000"]}',
		},
		"a cell that is null": { bytes: "null" },
		"a cell after a byte order mark": {
			bytes: '\uFEFF{"v":1,"value":"1","version":"00000000-0000-4000-8000-000000000000"}',
		},
		"a cell that is not UTF-8": {
			bytes: Buffer.concat([
				Buffer.from('{"v":1,"value":"\\"'),
				Buffer.from([0xff]),
				Buffer.from('\\"","version":"00000000-0000-4000-8000-000000000000"}'),
			]),
		},
	};
	const pathOf = (name: string) =>
		name === "a file of another name" ? `changesets/${changeset}/notes.txt` : `changesets/${changeset}/cell.json`;

	for (const [name, entry] of Object.entries(strays))
		it(`refuses every call on that changeset alone, for ${name}`, async () => {
			const path = pathOf(name);
			const store = await plantedBeside({ [path]: entry });
			await refusesEveryCall(store, changeset, path);
			expect(keys(await store.list(other))).toEqual(["kept"]);
			expect(await store.writeCell(other, undefined, '"lease"')).toBe(true);
		});

	it("refuses a record whose bytes give another ID, or are not canonical, or sit at another record's path", async () => {
		const real = filed(check("real"));
		const elsewhere = filed(check("elsewhere"));
		const cases: Record<string, Planted>[] = [
			{ [real.path]: { bytes: `${real.bytes} ` } },
			{ [real.path]: { bytes: filed(check("other bytes")).bytes } },
			{ [elsewhere.path.replace(/[0-9a-f]{64}\//, `${"0".repeat(64)}/`)]: elsewhere },
			{ [real.path]: { bytes: real.bytes, mode: "100755" } },
			{ [real.path.replace(".json", ".txt")]: { bytes: real.bytes } },
		];
		for (const entries of cases) {
			const fresh = await Remote.create();
			try {
				const store = await fresh.open();
				await store.add([check("kept", other)]);
				fresh.plant(entries);
				const [path] = Object.keys(entries) as [string];
				await refusesEveryCall(store, changeset, path);
				expect(keys(await store.list(other))).toEqual(["kept"]);
			} finally {
				await fresh.close();
			}
		}
	});

	it("refuses a path that is not UTF-8 by the changeset its folder names", async () => {
		const store = await plantedBeside({});
		const path = Buffer.concat([Buffer.from(`changesets/${changeset}/`), Buffer.from([0xff, 0x2e, 0x6a])]);
		remote.plantRaw([[path, { bytes: "" }]]);
		await expect(store.list(changeset)).rejects.toMatchObject({ code: "unknownFile" });
		expect(keys(await store.list(other))).toEqual(["kept"]);
	});

	it("carries the entry along unchanged in a commit another changeset's write pushes", async () => {
		const path = `changesets/${changeset}/notes.txt`;
		const store = await plantedBeside({ [path]: { bytes: "notes" } });
		const oid = remote.oid(path);
		await store.add([check("more", other)]);
		await store.dispose(other);
		expect(remote.oid(path)).toBe(oid);
		expect(remote.files()).toContain(path);
	});

	it("leaves unread a file below a folder named for the cell", async () => {
		const path = `changesets/${changeset}/cell.json/x.json`;
		const store = await plantedBeside({ [path]: { bytes: "{}" } });
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		await expect(store.list(changeset)).rejects.toSatisfy(refusal(path));
		expect(blobs.mock.calls.flatMap(([oids]) => oids)).not.toContain(remote.oid(path));
	});

	it("is judged by its path alone, and its bytes are never read", async () => {
		const path = `changesets/${changeset}/notes.txt`;
		const store = await plantedBeside({ [path]: { bytes: "notes" } });
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		await store.list(other);
		const oid = remote.oid(path);
		expect(blobs.mock.calls.flatMap(([oids]) => oids)).not.toContain(oid);
	});
});

describe("a stray entry outside every changeset's folder", { timeout: 60_000 }, () => {
	for (const path of [
		"index.json",
		"changesets/Bad Name!/x.json",
		"changesets/a..b/cell.json",
		`notes/${changeset}/x.json`,
	])
		it(`refuses every call on every changeset, for ${path}`, async () => {
			const store = await plantedBeside({ [path]: { bytes: "{}" } });
			await refusesEveryCall(store, changeset, path);
			await refusesEveryCall(store, other, path);
		});

	it("refuses every call on every changeset for a cell Melian would write, in a folder that names no changeset", async () => {
		const path = "changesets/a..b/cell.json";
		const store = await plantedBeside({
			[path]: { bytes: '{"v":1,"value":"1","version":"00000000-0000-4000-8000-000000000000"}' },
		});
		await refusesEveryCall(store, changeset, path);
		await refusesEveryCall(store, other, path);
	});

	it("refuses every changeset for a path that is not UTF-8 under a folder of another name", async () => {
		const store = await plantedBeside({});
		remote.plantRaw([[Buffer.concat([Buffer.from(`notes/${changeset}/`), Buffer.from([0xff])]), { bytes: "" }]]);
		await expect(store.list(changeset)).rejects.toMatchObject({ code: "unknownFile" });
		await expect(store.list(other)).rejects.toMatchObject({ code: "unknownFile" });
	});

	it("is judged by its path alone, and its bytes are never read", async () => {
		const path = `notes/${changeset}/cell.json`;
		const store = await plantedBeside({ [path]: { bytes: "{}" } });
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		await expect(store.list(other)).rejects.toSatisfy(refusal(path));
		expect(blobs.mock.calls.flatMap(([oids]) => oids)).not.toContain(remote.oid(path));
	});

	it("refuses every call on every changeset when changesets is a file", async () => {
		remote.plant({ changesets: { bytes: "{}" } });
		const store = await remote.open();
		await refusesEveryCall(store, changeset, "changesets");
		await refusesEveryCall(store, other, "changesets");
	});

	it("refuses every call when a changeset's folder is itself a file", async () => {
		const store = await plantedBeside({});
		remote.plant({ "changesets/zzz": { bytes: "{}" } });
		await refusesEveryCall(store, other, "changesets/zzz");
	});
});

describe("a record's size", { timeout: 60_000 }, () => {
	// A check record whose canonical bytes are exactly `size` long.
	function sized(size: number) {
		const bare = filed(check("big", changeset, { pad: "" })).bytes.length;
		return check("big", changeset, { pad: "x".repeat(size - bare) });
	}

	it("takes a record of the limit, and refuses one a byte past it before reaching the remote", async () => {
		const store = await remote.open();
		expect(filed(sized(fileLimit)).bytes.length).toBe(fileLimit);
		await store.add([sized(fileLimit)]);
		expect(keys(await store.list(changeset))).toEqual(["big"]);
		const fetch = vi.spyOn(RecordRepository.prototype, "fetch");
		await expect(store.add([sized(fileLimit + 1)])).rejects.toMatchObject({ code: "invalidRecord" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reads a file of the limit, and leaves one a byte past it unread as a stray", async () => {
		const store = await remote.open();
		const atLimit = filed(sized(fileLimit));
		remote.plant({ [atLimit.path]: { bytes: atLimit.bytes } });
		expect(keys(await store.list(changeset))).toEqual(["big"]);
		const past = filed(sized(fileLimit + 1));
		remote.plant({ [atLimit.path]: null, [past.path]: { bytes: past.bytes } });
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		const reader = await remote.open();
		await expect(reader.list(changeset)).rejects.toSatisfy(refusal(past.path));
		expect(blobs.mock.calls.flatMap(([oids]) => oids)).not.toContain(remote.oid(past.path));
	});
});
