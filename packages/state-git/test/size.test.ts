import { execFileSync } from "node:child_process";
import { recordLimit } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordRepository } from "../src/repository.ts";
import { cellPath } from "../src/state-tree.ts";
import { entryLimit, listingLimit, TipSize, tipLimit } from "../src/tip-size.ts";
import { changeset, check, filed, other, Remote } from "./fixtures/remote.ts";

let remote: Remote;

beforeEach(async () => {
	remote = await Remote.create();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await remote.close();
});

const remedy =
	"The daily prune removes the records of pull requests merged or closed over 30 days ago; if it has run, open work fills the tip.";
const sized = (entries: number, recordBytes: number, listingBytes: number) =>
	TipSize.of({ entries, recordBytes, listingBytes });
// Empty files outside every changeset's folder, which count as entries and hold no record bytes.
const strays = (count: number, length = 0) =>
	Object.fromEntries(
		Array.from({ length: count }, (_, n) => [`noise/${n}`.padEnd(length, "x"), { bytes: "" }] as const),
	);
// The length of the path that makes one line of `git ls-tree -r -z` a KiB: mode, type, object ID, tab and NUL.
const kibPath = 1024 - "100644 blob ".length - 40 - 2;
// The bytes git lists the branch's tip in, asked of git in the remote, not of the store.
const listingBytes = () =>
	execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", remote.tip()!], {
		cwd: remote.path,
		maxBuffer: 2 * listingLimit,
	}).length;

describe("a tip's size", () => {
	it("prints each count beside its limit, in whole MiB rounded down", () => {
		expect(sized(12_345, 48 * 1024 * 1024 + 1023, 9 * 1024 * 1024 - 1).line()).toBe(
			"melian/state: 12,345 of 65,536 entries, 48 MiB of 256 MiB, listing 8 MiB of 64 MiB",
		);
		expect(sized(0, 0, 0).line()).toBe(
			"melian/state: 0 of 65,536 entries, 0 MiB of 256 MiB, listing 0 MiB of 64 MiB",
		);
	});

	it("prints a listing past its limit, and counts nothing", () => {
		expect(TipSize.unlisted().line()).toBe(
			"melian/state: listing more than 64 MiB of 64 MiB, so its entries and bytes are not counted",
		);
		expect(TipSize.unlisted().warning()).toBe(
			`melian/state is past its listing limit: more than 67,108,864 bytes. ${remedy}`,
		);
	});

	it("warns of no count at exactly half its limit", () => {
		expect(sized(entryLimit / 2, tipLimit / 2, listingLimit / 2).warning()).toBeUndefined();
	});

	it("warns of entries one past half their limit, naming that measure alone", () => {
		expect(sized(entryLimit / 2 + 1, tipLimit / 2, listingLimit / 2).warning()).toBe(
			`melian/state is past half its entry limit: 32,769 of 65,536. ${remedy}`,
		);
	});

	it("warns of record bytes one past half their limit, naming that measure alone", () => {
		expect(sized(entryLimit / 2, tipLimit / 2 + 1, listingLimit / 2).warning()).toBe(
			`melian/state is past half its record byte limit: 134,217,729 of 268,435,456 bytes. ${remedy}`,
		);
	});

	it("warns of listing bytes one past half their limit, naming that measure alone", () => {
		expect(sized(entryLimit / 2, tipLimit / 2, listingLimit / 2 + 1).warning()).toBe(
			`melian/state is past half its listing limit: 33,554,433 of 67,108,864 bytes. ${remedy}`,
		);
	});

	it("says past half at exactly each limit, and past the limit one past it, naming every measure in one line", () => {
		expect(sized(entryLimit, tipLimit, listingLimit).warning()).toBe(
			`melian/state is past half its entry limit: 65,536 of 65,536; past half its record byte limit: 268,435,456 of 268,435,456 bytes; past half its listing limit: 67,108,864 of 67,108,864 bytes. ${remedy}`,
		);
		expect(sized(entryLimit + 1, tipLimit + 1, listingLimit + 1).warning()).toBe(
			`melian/state is past its entry limit: 65,537 of 65,536; past its record byte limit: 268,435,457 of 268,435,456 bytes; past its listing limit: 67,108,865 of 67,108,864 bytes. ${remedy}`,
		);
	});

	it("writes its counts as JSON and reads them back", () => {
		const size = sized(1, 2, 3);
		expect(JSON.parse(JSON.stringify(size))).toEqual({ entries: 1, recordBytes: 2, listingBytes: 3 });
		expect(TipSize.parse(JSON.parse(JSON.stringify(size)))).toEqual(size);
		expect(JSON.parse(JSON.stringify(TipSize.unlisted()))).toEqual({ listingPastLimit: true });
		expect(TipSize.parse({ listingPastLimit: true })).toEqual(TipSize.unlisted());
	});

	it("keeps only the three counts it is given", () => {
		const size = TipSize.of({ entries: 1, recordBytes: 2, listingBytes: 3, extra: "x" } as never);
		expect(JSON.stringify(size)).toBe('{"entries":1,"recordBytes":2,"listingBytes":3}');
	});

	it("reads no other shape", () => {
		const counts = { entries: 1, recordBytes: 2, listingBytes: 3 };
		for (const value of [
			null,
			"x",
			[],
			[1, 2, 3],
			{},
			{ listingPastLimit: false },
			{ listingPastLimit: "true" },
			{ listingPastLimit: true, entries: 1 },
			{ ...counts, note: "x" },
			{ entries: 1, recordBytes: 2 },
			{ ...counts, entries: -1 },
			{ ...counts, recordBytes: 1.5 },
			{ ...counts, listingBytes: "3" },
			{ ...counts, entries: Number.MAX_SAFE_INTEGER + 1 },
		])
			expect(() => TipSize.parse(value), JSON.stringify(value)).toThrow(
				new Error(
					value === null || typeof value !== "object" || Array.isArray(value)
						? "a tip size is a JSON object"
						: "a tip size holds entries, recordBytes and listingBytes, each a whole number",
				),
			);
		expect(TipSize.parse({ listingBytes: 0, recordBytes: 0, entries: 0 })).toEqual(sized(0, 0, 0));
	});
});

describe("the store's size", { timeout: 300_000 }, () => {
	it("counts nothing on a branch not there yet", async () => {
		expect(await (await remote.open()).size()).toEqual(sized(0, 0, 0));
	});

	it("counts the tip's entries, its records' and cells' bytes and its listing's bytes, and reads no blob", async () => {
		const store = await remote.open();
		await store.add([check("a"), check("b"), check("c", other)]);
		await store.writeCell(changeset, undefined, '"lease"');
		remote.plant({ "notes.txt": { bytes: "hello" } });
		const reader = await remote.open();
		const blobs = vi.spyOn(RecordRepository.prototype, "blobs");
		const cell = execFileSync("git", ["cat-file", "-s", `${remote.tip()}:${cellPath(changeset)}`], {
			cwd: remote.path,
		});
		const records = [check("a"), check("b"), check("c", other)].map((each) => Buffer.byteLength(filed(each).bytes));
		expect(await reader.size()).toEqual(
			sized(
				5,
				[...records, Number(cell.toString())].reduce((sum, bytes) => sum + bytes),
				listingBytes(),
			),
		);
		expect(blobs).not.toHaveBeenCalled();
	});

	it("counts a blob at each path it sits at, and none git sizes past a record", async () => {
		const bytes = filed(check("a")).bytes;
		remote.plant({ [filed(check("a")).path]: { bytes }, [filed(check("a", other)).path]: { bytes } });
		const store = await remote.open();
		const record = remote.oid(filed(check("a")).path);
		expect((await store.size()).counted?.recordBytes).toBe(2 * Buffer.byteLength(bytes));
		const sizes = RecordRepository.prototype.sizes;
		vi.spyOn(RecordRepository.prototype, "sizes").mockImplementation(async function (
			this: RecordRepository,
			...args
		) {
			const found = await sizes.apply(this, args);
			found.set(record, recordLimit + 1);
			return found;
		});
		expect((await store.size()).counted?.recordBytes).toBe(0);
	});

	it("counts a tip one entry past its limit, which every read refuses", async () => {
		const store = await remote.open();
		remote.plant(strays(entryLimit + 1));
		await expect(store.strays()).rejects.toMatchObject({ code: "unreachable" });
		expect(await store.size()).toEqual(sized(entryLimit + 1, 0, listingBytes()));
	});

	it("counts a tip one byte past its byte limit, which every read refuses", async () => {
		await (await remote.open()).add(Array.from({ length: 65 }, (_, n) => check(`r${n}`)));
		const store = await remote.open();
		vi.spyOn(RecordRepository.prototype, "sizes").mockImplementation(async (oids) => {
			const found = new Map(oids.map((oid) => [oid, recordLimit] as const));
			found.set(oids[0]!, 1);
			return found;
		});
		await expect(store.list(changeset)).rejects.toMatchObject({ code: "unreachable" });
		expect((await store.size()).counted?.recordBytes).toBe(tipLimit + 1);
	});

	it("answers a listing past its limit as unlisted, which every read refuses, and reads no sizes", async () => {
		const store = await remote.open();
		remote.plant({ ...strays(entryLimit - 1, kibPath), ["long/".padEnd(kibPath + 1, "x")]: { bytes: "" } });
		await expect(store.strays()).rejects.toMatchObject({ code: "unreachable" });
		const sizes = vi.spyOn(RecordRepository.prototype, "sizes");
		expect(await store.size()).toEqual(TipSize.unlisted());
		expect(sizes).not.toHaveBeenCalled();
	});

	it("counts a listing of exactly its limit", async () => {
		const store = await remote.open();
		remote.plant(strays(entryLimit, kibPath));
		expect(await store.size()).toEqual(sized(entryLimit, 0, listingLimit));
	});

	it("warns of none at exactly half the entry limit, and of entries one past it", async () => {
		const store = await remote.open();
		remote.plant(strays(entryLimit / 2));
		expect((await store.size()).warning()).toBeUndefined();
		remote.plant({ late: { bytes: "" } });
		expect((await store.size()).warning()).toMatch(/^melian\/state is past half its entry limit: 32,769 of 65,536\./);
	});

	it("warns of none at exactly half the listing limit, and of the listing one byte past it", async () => {
		const store = await remote.open();
		remote.plant(strays(entryLimit / 2, kibPath));
		expect(await store.size()).toEqual(sized(entryLimit / 2, 0, listingLimit / 2));
		expect((await store.size()).warning()).toBeUndefined();
		remote.plant({ [`noise/0`.padEnd(kibPath, "x")]: null, ["noise/0".padEnd(kibPath + 1, "x")]: { bytes: "" } });
		expect((await store.size()).warning()).toBe(
			`melian/state is past half its listing limit: 33,554,433 of 67,108,864 bytes. ${remedy}`,
		);
	});

	it("pushes nothing", async () => {
		const store = await remote.open();
		await store.add([check("a")]);
		const tip = remote.tip();
		const push = vi.spyOn(RecordRepository.prototype, "push");
		await store.size();
		expect(push).not.toHaveBeenCalled();
		expect(remote.tip()).toBe(tip);
	});

	it("refuses once closed", async () => {
		const store = await remote.open();
		await store.close();
		await expect(store.size()).rejects.toMatchObject({ code: "closed", message: "the record store is closed" });
	});
});
