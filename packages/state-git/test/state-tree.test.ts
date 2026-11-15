import { describe, expect, it } from "vitest";
import { Deadline, systemClock } from "../src/deadline.ts";
import type { RecordRepository, TreeEntry } from "../src/repository.ts";
import { cellPath, type Judged, StateTree } from "../src/state-tree.ts";

const entry: TreeEntry = {
	mode: "100644",
	type: "blob",
	oid: "1".repeat(40),
	path: Buffer.from(cellPath("pr-1")),
};

// A repository that lists `entries` and answers only for the objects asked about.
function listing(entries: readonly TreeEntry[]): RecordRepository {
	const bytes = '{"v":1,"value":"1","version":"00000000-0000-4000-8000-000000000000"}';
	return {
		entries: async () => [...entries],
		sizes: async (oids: readonly string[]) => new Map(oids.map((oid) => [oid, bytes.length])),
		blobs: async (sizes: ReadonlyMap<string, number>) =>
			new Map([...sizes.keys()].map((oid) => [oid, Buffer.from(bytes)])),
	} as unknown as RecordRepository;
}

describe("the judgement a handle keeps", () => {
	const changed: Record<keyof TreeEntry, TreeEntry[keyof TreeEntry]> = {
		mode: "100755",
		type: "commit",
		oid: "2".repeat(40),
		path: Buffer.from(cellPath("pr-2")),
	};

	for (const field of Object.keys(entry) as (keyof TreeEntry)[])
		it(`is judged again when only its ${field} changes`, async () => {
			const judged = new Map<string, Judged>();
			await StateTree.read(listing([entry]), "melian/state", "tip", judged, Deadline.after(systemClock, 30_000));
			await StateTree.read(
				listing([{ ...entry, [field]: changed[field] }]),
				"melian/state",
				"tip",
				judged,
				Deadline.after(systemClock, 30_000),
			);
			expect(judged.size).toBe(2);
		});

	it("covers every field of an entry", () => {
		expect(Object.keys(changed).sort()).toEqual(Object.keys(entry).sort());
	});

	it("is kept when nothing changes", async () => {
		const judged = new Map<string, Judged>();
		await StateTree.read(listing([entry]), "melian/state", "tip", judged, Deadline.after(systemClock, 30_000));
		await StateTree.read(
			listing([{ ...entry, path: Buffer.from(entry.path) }]),
			"melian/state",
			"tip",
			judged,
			Deadline.after(systemClock, 30_000),
		);
		expect(judged.size).toBe(1);
	});
});
