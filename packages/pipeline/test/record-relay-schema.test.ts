import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig, pullRequestChangesetId, SharedRecord, TierAccount, withheld } from "@melian-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { RelayBatch, RelayRefusal } from "../src/record-relay.ts";
import { ReviewRecords } from "../src/review-records.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const changeset = pullRequestChangesetId("github", { owner: "octo", name: "repo" }, 7);
const tier = TierAccount.of(defaultConfig, "full", { loaded: [], selected: [] });
// This file tests how the relay reads a record, so its fork may hand over the one check its records name.
const fork = { changeset, revision: `${base}..${head}`, fork: true, tier, handedOver: ["static.biome"] };

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const valid = ReviewRecords.of(changeset, { base, head })
	.check("d".repeat(64), { name: "static.biome", status: "ran", version: "2.0.0", findings: 0, notes: [] }, [])
	.toJSON();

// A check record whose payload `change` rewrites, filed where its own bytes say, as a head's job could leave it.
async function planted(change: (payload: Record<string, unknown>) => Record<string, unknown>): Promise<string> {
	const record = SharedRecord.parseEnvelope({ ...valid, payload: change(valid.payload as Record<string, unknown>) });
	const directory = await mkdtemp(join(tmpdir(), "melian-relay-schema-"));
	directories.push(directory);
	await mkdir(dirname(join(directory, record.path)), { recursive: true });
	await writeFile(join(directory, record.path), record.bytes);
	return directory;
}

async function refused(directory: string): Promise<RelayRefusal> {
	const error = await RelayBatch.read(directory, fork).then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(RelayRefusal);
	return error as RelayRefusal;
}

const result = (payload: Record<string, unknown>) => payload.result as Record<string, unknown>;

describe("the relay trusts the payload schema, not the writer", () => {
	it("takes the unchanged record", async () => {
		const batch = await RelayBatch.read(await planted((payload) => payload), fork);
		expect(batch.records).toHaveLength(1);
	});

	it("refuses a code outside its closed set", async () => {
		const found = await refused(
			await planted((payload) => ({
				...payload,
				result: { name: "static.biome", status: "skipped", reason: "no paths", cause: "ghp_token" },
			})),
		);
		expect(found.code).toBe("invalidRecord");
		expect(found.message).not.toContain("ghp_token");
	});

	it("refuses an unknown field", async () => {
		const found = await refused(
			await planted((payload) => ({ ...payload, result: { ...result(payload), leak: "ghp_token" } })),
		);
		expect(found.code).toBe("invalidRecord");
		expect(found.message).not.toContain("ghp_token");
	});

	describe("a field classed as an ID or hash", () => {
		const snapshot = (snapshotId: string) => ({
			commit: head,
			snapshotId,
			receipt: withheld,
			cacheKey: null,
			coverage: null,
		});
		const withSnapshot = (snapshotId: string) =>
			planted((payload) => ({ ...payload, result: { ...result(payload), snapshots: [snapshot(snapshotId)] } }));

		it("takes a snapshot ID", async () => {
			const batch = await RelayBatch.read(await withSnapshot(`sha256:${"c".repeat(64)}`), fork);
			expect(batch.records).toHaveLength(1);
		});

		it("refuses free text in it", async () => {
			const found = await refused(await withSnapshot("ghp_token"));
			expect(found.code).toBe("invalidRecord");
			expect(found.message).not.toContain("ghp_token");
		});
	});
});
