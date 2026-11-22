import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalJson,
	DirectoryRecordStore,
	MemoryRecordStore,
	type RecordEnvelope,
	RecordError,
	recordLimit,
	SharedRecord,
} from "@melian-agent/core";
import { recordKey, testPayloads } from "@melian-agent/core/testing";
import { afterEach, describe, expect, it } from "vitest";

const changeset = "pull-0123456789abcdef";
const anyPayload = testPayloads;

function envelope(key: string, pad: string): RecordEnvelope {
	return { v: 1, changeset, kind: "check", key: recordKey(key), payload: { pad } } as RecordEnvelope;
}

// A check record of exactly `size` bytes, its pad made of `unit` (any UTF-8 width) and ASCII to finish.
function sized(key: string, size: number, unit: string): RecordEnvelope {
	const bare = Buffer.byteLength(SharedRecord.parse(envelope(key, ""), anyPayload).bytes);
	const width = Buffer.byteLength(unit);
	const room = size - bare;
	const pad = unit.repeat(Math.floor(room / width)) + "x".repeat(room % width);
	return envelope(key, pad);
}

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("the record limit at its bound, in multi-byte UTF-8", () => {
	for (const [label, unit] of [
		["two-byte", "é"],
		["three-byte", "€"],
		["four-byte", "\u{1F600}"],
	] as const) {
		it(`a memory and a directory store take a ${label} record of exactly the limit, and refuse one byte past`, async () => {
			const at = sized("at", recordLimit, unit);
			const past = sized("past", recordLimit + 1, unit);
			expect(Buffer.byteLength(SharedRecord.parse(at, anyPayload).bytes)).toBe(recordLimit);
			expect(Buffer.byteLength(SharedRecord.parse(past, anyPayload).bytes)).toBe(recordLimit + 1);
			// The string's length in UTF-16 is well under the limit, so a check by `.length` would let it through.
			expect(SharedRecord.parse(past, anyPayload).bytes.length).toBeLessThan(recordLimit);

			const memory = new MemoryRecordStore({ payloads: anyPayload });
			await memory.add([at]);
			expect((await memory.list(changeset)).map((each) => canonicalJson(each))).toEqual([
				SharedRecord.parse(at, anyPayload).bytes,
			]);
			await expect(memory.add([past])).rejects.toMatchObject({ code: "invalidRecord" });

			const directory = await mkdtemp(join(tmpdir(), "melian-record-limit-"));
			directories.push(directory);
			const store = await DirectoryRecordStore.open(directory, anyPayload);
			await store.add([at]);
			expect((await store.list(changeset)).map((each) => canonicalJson(each))).toEqual([
				SharedRecord.parse(at, anyPayload).bytes,
			]);
			await expect(store.add([past])).rejects.toBeInstanceOf(RecordError);
			await store.close();
		});
	}
});
