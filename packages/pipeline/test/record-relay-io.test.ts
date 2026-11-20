import type * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DirectoryRecordStore,
	defaultConfig,
	pullRequestChangesetId,
	reviewPayloads,
	TierAccount,
} from "@melian-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayBatch, RelayRefusal, relayLimits } from "../src/record-relay.ts";
import { ReviewRecords } from "../src/review-records.ts";

// A file the listing named can be gone, or unreadable, by the time the relay measures or reads it.
const failing = vi.hoisted(() => ({ lstat: false, readFile: false }));
// Every entry a directory listing has handed the relay, one at a time.
const walked = vi.hoisted(() => ({ entries: 0 }));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fsPromises>();
	const gone = () => Promise.reject(Object.assign(new Error("ENOENT: gone"), { code: "ENOENT" }));
	return {
		...actual,
		opendir: async (...args: Parameters<typeof actual.opendir>) => {
			const dir = await actual.opendir(...args);
			const read = dir.read.bind(dir);
			return Object.assign(dir, {
				read: async () => {
					const entry = await read();
					if (entry !== null) walked.entries += 1;
					return entry;
				},
				async *[Symbol.asyncIterator]() {
					try {
						for (let entry = await dir.read(); entry !== null; entry = await dir.read()) yield entry;
					} finally {
						await dir.close().catch(() => undefined);
					}
				},
			});
		},
		lstat: (...args: Parameters<typeof actual.lstat>) => (failing.lstat ? gone() : actual.lstat(...args)),
		readFile: (...args: Parameters<typeof actual.readFile>) => (failing.readFile ? gone() : actual.readFile(...args)),
	};
});

const changeset = pullRequestChangesetId("github", { owner: "octo", name: "repo" }, 7);
const revision = { base: "a".repeat(40), head: "b".repeat(40) };
const tier = TierAccount.of({ ...defaultConfig, tiers: { relay: ["static.biome"] } }, "relay", {
	loaded: [],
	selected: [],
});
// This file tests how the relay reads a record, so its fork may hand over the one check its records name.
const fork = {
	changeset,
	revision: `${revision.base}..${revision.head}`,
	fork: true,
	tier,
	handedOver: ["static.biome"],
};

let directory = "";
afterEach(async () => {
	failing.lstat = false;
	failing.readFile = false;
	walked.entries = 0;
	await rm(directory, { recursive: true, force: true });
});

describe("RelayBatch on a file that fails as it reads", () => {
	it.each([
		["measures", "lstat", "unreadable"],
		["reads", "readFile", "invalidRecord"],
	] as const)("refuses a file it cannot %s, naming no code of a record", async (_, call, code) => {
		directory = await mkdtemp(join(tmpdir(), "melian-relay-io-"));
		const record = ReviewRecords.of(changeset, revision).check(
			"d".repeat(64),
			{ name: "static.biome", status: "ran", version: "2.0.0", findings: 0, notes: [] },
			[],
		);
		const store = await DirectoryRecordStore.open(directory, reviewPayloads);
		await store.add([record.toJSON()]);
		await store.close();
		failing[call] = true;
		const error = await RelayBatch.read(directory, fork).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(RelayRefusal);
		expect([(error as RelayRefusal).code, (error as RelayRefusal).recordCode]).toEqual([code, undefined]);
	});
});

describe("RelayBatch on a folder with more entries than it walks", () => {
	it("stops reading the folder at the entry past its bound", async () => {
		directory = await mkdtemp(join(tmpdir(), "melian-relay-io-"));
		const kind = join(directory, "changesets", changeset, "check");
		await mkdir(kind, { recursive: true });
		for (let index = 0; index < relayLimits.entries + 100; index++)
			await mkdir(join(kind, index.toString(16).padStart(64, "0")));
		const error = await RelayBatch.read(directory, fork).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as RelayRefusal).code).toBe("tooManyEntries");
		expect(walked.entries).toBe(relayLimits.entries + 1);
	}, 120_000);
});
