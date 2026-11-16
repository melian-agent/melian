import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DirectoryRecordStore,
	MemoryRecordStore,
	pullRequestChangesetId,
	reviewPayloads,
	SharedRecord,
} from "@melian-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { RelayBatch, RelayRefusal, relayLimits } from "../src/record-relay.ts";
import { ReviewRecords } from "../src/review-records.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
// A real changeset ID, as the relay works it out for a pull request.
const changeset = pullRequestChangesetId("github", { owner: "octo", name: "repo" }, 7);
const request = "d".repeat(64);
const revision = `${base}..${head}`;
const writer = { changeset, revision, fork: false };
const fork = { changeset, revision, fork: true };

const records = () => ReviewRecords.of(changeset, { base, head });
const check = (name = "static.biome") =>
	records().check(request, { name, status: "ran", version: "2.0.0", findings: 0, notes: [] }, []);

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "melian-relay-"));
	directories.push(directory);
	return directory;
}

// A directory store as the round job's `melian review --records` leaves it.
async function artefact(...written: SharedRecord[]): Promise<string> {
	const directory = await scratch();
	const store = await DirectoryRecordStore.open(directory, reviewPayloads);
	await store.add(written.map((record) => record.toJSON()));
	await store.close();
	return directory;
}

async function plant(directory: string, path: string, bytes: string | Buffer): Promise<void> {
	await mkdir(dirname(join(directory, path)), { recursive: true });
	await writeFile(join(directory, path), bytes);
}

async function refusal(read: Promise<unknown>): Promise<RelayRefusal> {
	const error = await read.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(RelayRefusal);
	return error as RelayRefusal;
}

describe("RelayBatch", () => {
	it("adds a writer's check, lens and round records to the store whole", async () => {
		const biome = check();
		const round = records().round([biome], undefined, [], []);
		const batch = await RelayBatch.read(await artefact(biome, round), writer);
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await batch.into(store);
		expect((await store.list(changeset)).map((each) => each.kind).sort()).toEqual(["check", "round"]);
	});

	it("takes a fork's check record", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await (await RelayBatch.read(await artefact(check()), fork)).into(store);
		expect(await store.list(changeset)).toHaveLength(1);
	});

	it("refuses a round from a fork's head, so a made-up round is never added", async () => {
		const biome = check();
		const found = await refusal(
			RelayBatch.read(await artefact(biome, records().round([biome], undefined, [], [])), fork),
		);
		expect(found.code).toBe("refusedKind");
	});

	it("refuses a dismissal, which no head's job hands over, before it reads the payload", async () => {
		const dismissal = SharedRecord.parseEnvelope({
			v: 1,
			changeset,
			kind: "dismissal",
			key: "0123456789abcdef",
			payload: {},
		});
		const directory = await artefact();
		await plant(directory, dismissal.path, dismissal.bytes);
		expect((await refusal(RelayBatch.read(directory, writer))).code).toBe("refusedKind");
	});

	it("refuses a record of another revision", async () => {
		const other = ReviewRecords.of(changeset, { base, head: "e".repeat(40) }).check(
			request,
			{ name: "static.biome", status: "ran", version: "2.0.0", findings: 0, notes: [] },
			[],
		);
		expect((await refusal(RelayBatch.read(await artefact(other), writer))).code).toBe("otherRevision");
	});

	it("refuses a record of another changeset, by its folder", async () => {
		const other = ReviewRecords.of(pullRequestChangesetId("github", { owner: "octo", name: "repo" }, 8), {
			base,
			head,
		}).check(request, { name: "static.biome", status: "ran", version: "2.0.0", findings: 0, notes: [] }, []);
		expect((await refusal(RelayBatch.read(await artefact(other), writer))).code).toBe("otherChangeset");
	});

	it("refuses a signed record", async () => {
		const unsigned = check().toJSON();
		const signed = { ...unsigned, signer: "someone", signature: Buffer.alloc(64).toString("base64") };
		const directory = await scratch();
		const store = await DirectoryRecordStore.open(directory, reviewPayloads);
		await store.add([signed]);
		await store.close();
		expect((await refusal(RelayBatch.read(directory, writer))).code).toBe("signed");
	});

	it("refuses a file whose bytes are no record, naming the file and nothing it holds", async () => {
		const directory = await artefact(check());
		const path = `changesets/${changeset}/check/${"0".repeat(64)}/${"1".repeat(64)}.json`;
		await plant(directory, path, '{"secret":"ghp_token"}');
		const found = await refusal(RelayBatch.read(directory, writer));
		expect(found.code).toBe("invalidRecord");
		expect(found.file).toBe(path);
		expect(found.message).not.toContain("ghp_token");
		expect(found.message).not.toContain("secret");
	});

	it("refuses a record filed at a path its bytes do not give", async () => {
		const record = check();
		const directory = await artefact();
		await plant(directory, `changesets/${changeset}/check/${"0".repeat(64)}/${record.id}.json`, record.bytes);
		expect((await refusal(RelayBatch.read(directory, writer))).code).toBe("misplaced");
	});

	it("refuses a link, a cell and a file the store never writes", async () => {
		const record = check();
		const linked = await artefact();
		await mkdir(dirname(join(linked, record.path)), { recursive: true });
		await symlink("/etc/hostname", join(linked, record.path));
		expect((await refusal(RelayBatch.read(linked, writer))).code).toBe("strayEntry");

		const cell = await artefact(record);
		await plant(cell, `changesets/${changeset}/.cell/1`, "value");
		expect((await refusal(RelayBatch.read(cell, writer))).code).toBe("strayEntry");

		const loose = await artefact(record);
		await plant(loose, "notes.txt", "hello");
		expect((await refusal(RelayBatch.read(loose, writer))).code).toBe("strayEntry");
	});

	it("refuses a round that reads a record in neither the batch nor the store", async () => {
		const biome = check();
		const round = records().round([biome], undefined, [], []);
		const batch = await RelayBatch.read(await artefact(round), writer);
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const found = await refusal(batch.into(store));
		expect(found.code).toBe("unresolvedRead");
		expect(await store.list(changeset)).toEqual([]);
	});

	it("takes a round that reads a record the store already holds", async () => {
		const biome = check();
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await store.add([biome.toJSON()]);
		const round = records().round([biome], undefined, [], []);
		await (await RelayBatch.read(await artefact(round), writer)).into(store);
		expect(await store.list(changeset)).toHaveLength(2);
	});

	it("takes the most files it allows, and refuses one more", async () => {
		const at = await artefact();
		for (let index = 0; index < relayLimits.files; index++)
			await plant(
				at,
				`changesets/${changeset}/check/${"0".repeat(64)}/${index.toString(16).padStart(64, "0")}.json`,
				"{}",
			);
		expect((await refusal(RelayBatch.read(at, writer))).code).toBe("invalidRecord");
		await plant(at, `changesets/${changeset}/check/${"1".repeat(64)}/${"f".repeat(64)}.json`, "{}");
		expect((await refusal(RelayBatch.read(at, writer))).code).toBe("tooManyFiles");
	}, 120_000);

	it("takes a file at its byte bound, and refuses one byte more", async () => {
		const path = `changesets/${changeset}/check/${"0".repeat(64)}/${"1".repeat(64)}.json`;
		const at = await artefact();
		await plant(at, path, Buffer.alloc(relayLimits.fileBytes, 0x20));
		expect((await refusal(RelayBatch.read(at, writer))).code).toBe("invalidRecord");
		await plant(at, path, Buffer.alloc(relayLimits.fileBytes + 1, 0x20));
		expect((await refusal(RelayBatch.read(at, writer))).code).toBe("fileTooLarge");
	});

	it("takes a batch at its byte bound, and refuses one byte more", async () => {
		const at = await artefact();
		const files = relayLimits.bytes / relayLimits.fileBytes;
		for (let index = 0; index < files; index++)
			await plant(
				at,
				`changesets/${changeset}/check/${"0".repeat(64)}/${index.toString(16).padStart(64, "0")}.json`,
				Buffer.alloc(relayLimits.fileBytes, 0x20),
			);
		expect((await refusal(RelayBatch.read(at, writer))).code).toBe("invalidRecord");
		await plant(at, `changesets/${changeset}/check/${"1".repeat(64)}/${"f".repeat(64)}.json`, " ");
		expect((await refusal(RelayBatch.read(at, writer))).code).toBe("batchTooLarge");
	}, 120_000);
});
