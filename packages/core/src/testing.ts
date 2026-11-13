import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryRecordStore } from "./directory-record-store.ts";
import { RecordError, type RecordErrorCode } from "./errors.ts";
import { type PayloadChecks, type RecordEnvelope, type RecordJson, SharedRecord } from "./record.ts";
import { disposalMark, MemoryRecordSpace, MemoryRecordStore, type RecordStore } from "./record-store.ts";

/** One store under test, with as many handles on it as a case asks for. */
export interface RecordStoreSubject {
	/** Opens another handle on the same store, as a second host would. */
	open(): Promise<RecordStore>;
	/** Cuts every handle off from the store, so that no call can be answered fresh. */
	cutOff(): Promise<void>;
	/**
	 * Puts among a changeset's records of `kind` an entry the store did not write, leading out of the store where the
	 * store can hold such a thing, as a directory holds a link. Resolves to a check that something reached outside.
	 */
	plant(changeset: string, kind: string): Promise<() => Promise<boolean>>;
	/** Closes every handle and releases the store. */
	close(): Promise<void>;
}

/** Makes a new, empty store for one conformance case. */
export type RecordStoreFixture = () => Promise<RecordStoreSubject>;

/** One promise of the record store port, and the case that fails when an adapter breaks it. */
export type RecordStoreCase = { name: string; run(fixture: RecordStoreFixture): Promise<void> };

/**
 * Payload checks that take any payload of every kind but a round, for tests alone. A kind's real check comes from the
 * build that defines its payload, and core registers none, so without these no record but a round parses.
 */
export const testPayloads: PayloadChecks = Object.fromEntries(
	[
		"check",
		"lens",
		"verification",
		"walkthrough",
		"telemetry",
		"marker",
		"dismissal",
		"post",
		"status",
		"ledger-comment",
		"comparison",
	].map((kind) => [kind, () => undefined]),
);

const changeset = "pull-0123456789abcdef";
const other = "range-0123456789abcdef";

const revision = ["a".repeat(40), "b".repeat(40)].join("..");

function envelope(kind: string, key: string, payload: RecordJson, within = changeset): RecordEnvelope {
	if (kind === "round") payload = { read: [], walkthrough: null, replaces: [], before: [] };
	return { v: 1, changeset: within, kind, key, payload, ...(kind === "round" ? { revision } : {}) };
}

function ids(records: RecordEnvelope[]): string[] {
	return records.map((record) => SharedRecord.parse(record, testPayloads).id).sort();
}

function idsOf(...records: RecordEnvelope[]): string[] {
	return ids(records);
}

function refusal(code: RecordErrorCode): (error: unknown) => boolean {
	return (error) => error instanceof RecordError && error.code === code;
}

async function using(fixture: RecordStoreFixture, body: (subject: RecordStoreSubject) => Promise<void>): Promise<void> {
	const subject = await fixture();
	try {
		await body(subject);
	} finally {
		await subject.close();
	}
}

/**
 * The conformance suite every `RecordStore` adapter passes: one case per promise of rule 3 of [the shared record
 * decision](../../../docs/decisions/2026-11-13-shared-record-behind-a-store-port.md), and one that refuses a changeset
 * name no envelope could hold. Register each case with the test runner, as `it(c.name, () => c.run(fixture))`.
 */
export const recordStoreConformance: readonly RecordStoreCase[] = [
	{
		name: "add: the same bytes added twice are one record, and a repeat completes a batch",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				const first = envelope("check", "static.biome", { status: "ran", findings: 0 });
				const second = envelope("check", "guardrails", { status: "ran", findings: 1 });
				await store.add([first]);
				await store.add([
					{ payload: { findings: 0, status: "ran" }, key: "static.biome", kind: "check", changeset, v: 1 },
				]);
				await store.add([first, second]);
				const listed = await store.list(changeset);
				assert.deepEqual(ids(listed), idsOf(first, second));
				assert.deepEqual(
					listed.map((record) => SharedRecord.parse(record, testPayloads).bytes).sort(),
					[first, second].map((record) => SharedRecord.parse(record, testPayloads).bytes).sort(),
				);
			}),
	},
	{
		name: "add: two records in one slot are both kept",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				const one = envelope("lens", "correctness", { findings: 1 });
				const two = envelope("lens", "correctness", { findings: 3 });
				await store.add([one, two]);
				assert.deepEqual(ids(await store.list(changeset)), idsOf(one, two));
			}),
	},
	{
		name: "add: refuses an invalid record before any of its batch lands",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				const valid = envelope("check", "guardrails", {});
				await assert.rejects(store.add([valid, envelope("unknown", "x", {})]), refusal("unknownKind"));
				assert.deepEqual(await store.list(changeset), []);
			}),
	},
	{
		name: "list: returns every record whose add returned before it, on any handle, and only its changeset's",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const writer = await subject.open();
				const reader = await subject.open();
				assert.deepEqual(await reader.list(changeset), []);
				const first = envelope("check", "guardrails", {});
				await writer.add([first, envelope("check", "guardrails", {}, other)]);
				assert.deepEqual(ids(await reader.list(changeset)), idsOf(first));
				const second = envelope("round", "r", {});
				await writer.add([second]);
				assert.deepEqual(ids(await reader.list(changeset)), idsOf(first, second));
			}),
	},
	{
		name: "list: fails when the store cannot answer it fresh",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				await store.add([envelope("check", "guardrails", {})]);
				await subject.cutOff();
				await assert.rejects(store.list(changeset), refusal("unreachable"));
			}),
	},
	{
		name: "readCell: returns the last value a writeCell stored, on any handle",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const writer = await subject.open();
				const reader = await subject.open();
				assert.deepEqual(await reader.readCell(changeset), {});
				assert.equal(await writer.writeCell(changeset, undefined, "lease A"), true);
				const first = await reader.readCell(changeset);
				assert.equal(first.value, "lease A");
				assert.equal(typeof first.version, "string");
				assert.equal(await writer.writeCell(changeset, first.version, "lease B"), true);
				assert.equal((await reader.readCell(changeset)).value, "lease B");
				assert.deepEqual(await reader.readCell(other), {});
			}),
	},
	{
		name: "readCell: fails when the store cannot answer it fresh",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				await store.writeCell(changeset, undefined, "lease");
				await subject.cutOff();
				await assert.rejects(store.readCell(changeset), refusal("unreachable"));
			}),
	},
	{
		name: "add and writeCell: fail when the store cannot be reached",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				await subject.cutOff();
				await assert.rejects(store.add([envelope("check", "guardrails", {})]), refusal("unreachable"));
				await assert.rejects(store.writeCell(changeset, undefined, "lease"), refusal("unreachable"));
			}),
	},
	{
		name: "writeCell: succeeds only while the version is still the expected one",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				assert.equal(await store.writeCell(changeset, "never-written", "lease A"), false);
				assert.deepEqual(await store.readCell(changeset), {});
				assert.equal(await store.writeCell(changeset, undefined, "lease A"), true);
				const { version } = await store.readCell(changeset);
				assert.equal(await store.writeCell(changeset, undefined, "lease B"), false);
				assert.equal(await store.writeCell(changeset, `${version}x`, "lease B"), false);
				assert.equal((await store.readCell(changeset)).value, "lease A");
				assert.equal(await store.writeCell(changeset, version, "lease B"), true);
				assert.equal(await store.writeCell(changeset, version, "lease C"), false);
				assert.equal((await store.readCell(changeset)).value, "lease B");
			}),
	},
	{
		name: "writeCell: every successful write changes the version, the same value included",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				await store.writeCell(changeset, undefined, "same");
				const first = await store.readCell(changeset);
				assert.equal(await store.writeCell(changeset, first.version, "same"), true);
				const second = await store.readCell(changeset);
				assert.equal(second.value, "same");
				assert.notEqual(second.version, first.version);
				assert.equal(await store.writeCell(changeset, first.version, "same"), false);
			}),
	},
	{
		name: "writeCell: refuses a version whose value went away and came back",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				await store.writeCell(changeset, undefined, "A");
				const stale = await store.readCell(changeset);
				await store.writeCell(changeset, stale.version, "B");
				await store.writeCell(changeset, (await store.readCell(changeset)).version, "A");
				const back = await store.readCell(changeset);
				assert.equal(back.value, "A");
				assert.notEqual(back.version, stale.version);
				assert.equal(await store.writeCell(changeset, stale.version, "C"), false);
				assert.equal((await store.readCell(changeset)).value, "A");
			}),
	},
	{
		name: "writeCell: of two writers racing from one version, exactly one wins",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const [first, second] = [await subject.open(), await subject.open()];
				const won = await Promise.all([
					first.writeCell(changeset, undefined, "first"),
					second.writeCell(changeset, undefined, "second"),
				]);
				assert.equal(won.filter(Boolean).length, 1);
				assert.equal((await first.readCell(changeset)).value, won[0] ? "first" : "second");
			}),
	},
	{
		name: "writeCell: refuses the disposal mark, which only dispose writes",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				await assert.rejects(store.writeCell(changeset, undefined, disposalMark), refusal("invalidCell"));
				assert.deepEqual(await store.readCell(changeset), {});
				await store.writeCell(changeset, undefined, "lease");
				const { version } = await store.readCell(changeset);
				await assert.rejects(store.writeCell(changeset, version, disposalMark), refusal("invalidCell"));
				assert.equal((await store.readCell(changeset)).value, "lease");
				await store.add([envelope("check", "guardrails", {})]);
				assert.equal((await store.list(changeset)).length, 1);
			}),
	},
	{
		name: "writeCell: refuses a value no adapter could store unchanged",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				const lone = `lease ${String.fromCharCode(0xd800)}`;
				await assert.rejects(store.writeCell(changeset, undefined, lone), refusal("invalidCell"));
				assert.deepEqual(await store.readCell(changeset), {});
				const pair = `lease ${String.fromCharCode(0xd83d, 0xde00)}`;
				assert.equal(await store.writeCell(changeset, undefined, pair), true);
				assert.equal((await store.readCell(changeset)).value, pair);
			}),
	},
	{
		name: "dispose: marks the cell, removes the records for good, and leaves other changesets",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				const kept = envelope("check", "guardrails", {}, other);
				await store.add([envelope("check", "guardrails", {}), kept]);
				await store.writeCell(changeset, undefined, "lease");
				await store.writeCell(other, undefined, "lease");
				await store.dispose(changeset);
				assert.deepEqual(await store.list(changeset), []);
				const cell = await store.readCell(changeset);
				assert.equal(cell.value, disposalMark);
				await assert.rejects(store.add([envelope("check", "late", {})]), refusal("disposed"));
				assert.deepEqual(await store.list(changeset), []);
				await assert.rejects(store.writeCell(changeset, cell.version, "lease"), refusal("disposed"));
				await store.dispose(changeset);
				assert.equal((await store.readCell(changeset)).value, disposalMark);
				assert.deepEqual(ids(await store.list(other)), idsOf(kept));
				assert.equal((await store.readCell(other)).value, "lease");
			}),
	},
	{
		name: "list and add refuse an entry the store did not write, and write nothing through it",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				const escaped = await subject.plant(changeset, "check");
				await assert.rejects(store.list(changeset), refusal("unknownFile"));
				await assert.rejects(store.add([envelope("check", "guardrails", {})]), refusal("unknownFile"));
				assert.equal(await escaped(), false);
				const elsewhere = envelope("check", "guardrails", {}, other);
				await store.add([elsewhere]);
				assert.deepEqual(ids(await store.list(other)), idsOf(elsewhere));
			}),
	},
	{
		name: "every call refuses a changeset name no envelope could hold, and takes a dotted one",
		run: (fixture) =>
			using(fixture, async (subject) => {
				const store = await subject.open();
				for (const outside of ["../outside", "a/b", "a.", "a..b", "A"]) {
					await assert.rejects(store.list(outside), refusal("invalidChangeset"));
					await assert.rejects(store.readCell(outside), refusal("invalidChangeset"));
					await assert.rejects(store.writeCell(outside, undefined, "lease"), refusal("invalidChangeset"));
					await assert.rejects(store.dispose(outside), refusal("invalidChangeset"));
				}
				const dotted = "github.melian-agent.pull-399";
				const record = envelope("check", "guardrails", {}, dotted);
				await store.add([record]);
				assert.deepEqual(ids(await store.list(dotted)), idsOf(record));
				assert.equal(await store.writeCell(dotted, undefined, "lease"), true);
			}),
	},
];

/** A fixture for the memory adapter: every handle on one `MemoryRecordSpace`. */
export function memoryRecordStoreFixture(): RecordStoreFixture {
	return async () => {
		const space = new MemoryRecordSpace();
		const handles: RecordStore[] = [];
		return {
			open: async () => {
				const store = new MemoryRecordStore({ space, payloads: testPayloads });
				handles.push(store);
				return store;
			},
			cutOff: async () => space.disconnect(),
			plant: async (name, kind) => {
				space.plant(name, kind);
				return async () => false;
			},
			close: async () => {
				for (const store of handles) await store.close();
			},
		};
	};
}

/**
 * A fixture for the directory adapter: every handle on one temporary directory, which `cutOff` removes, and `plant`
 * links a kind's directory to a second one outside it.
 */
export function directoryRecordStoreFixture(): RecordStoreFixture {
	return async () => {
		const root = await mkdtemp(join(tmpdir(), "melian-records-"));
		const outside = await mkdtemp(join(tmpdir(), "melian-records-outside-"));
		const handles: RecordStore[] = [];
		return {
			open: async () => {
				const store = await DirectoryRecordStore.open(root, testPayloads);
				handles.push(store);
				return store;
			},
			cutOff: () => rm(root, { recursive: true, force: true }),
			plant: async (name, kind) => {
				await mkdir(join(root, "changesets", name), { recursive: true });
				await symlink(outside, join(root, "changesets", name, kind));
				return async () => (await readdir(outside)).length > 0;
			},
			close: async () => {
				for (const store of handles) await store.close();
				await rm(root, { recursive: true, force: true });
				await rm(outside, { recursive: true, force: true });
			},
		};
	};
}
