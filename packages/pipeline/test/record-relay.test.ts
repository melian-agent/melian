import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DirectoryRecordStore,
	defaultConfig,
	LevelBand,
	MemoryRecordStore,
	pullRequestChangesetId,
	reviewPayloads,
	SharedRecord,
	TierAccount,
} from "@melian-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { RelayBatch, RelayRefusal, relayLimits } from "../src/record-relay.ts";
import { ReviewRecords } from "../src/review-records.ts";
import { verifierVersion } from "../src/verification-instructions.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
// A real changeset ID, as the relay works it out for a pull request.
const changeset = pullRequestChangesetId("github", { owner: "octo", name: "repo" }, 7);
const request = "d".repeat(64);
const revision = `${base}..${head}`;
// A tier of one check, as the base's policy gives it.
const tier = TierAccount.of({ ...defaultConfig, tiers: { relay: ["static.biome"] } }, "relay", {
	loaded: [],
	selected: [],
});
// A writer's batch is judged by its round, so the checks a fork's job may hand over decide nothing for it.
const writer = { changeset, revision, fork: false, tier, handedOver: [] };
// A tier that gives a second check, for batches whose refusal comes before the account's.
const wide = {
	...writer,
	tier: TierAccount.of({ ...defaultConfig, tiers: { relay: ["static.biome", "static.tsc"] } }, "relay", {
		loaded: [],
		selected: [],
	}),
};
// A fork's job hands over only what runs the head's code, so its tier gives a check it may not hand over beside one it may.
const fork = {
	changeset,
	revision,
	fork: true,
	tier: TierAccount.of({ ...defaultConfig, tiers: { relay: ["static.biome", "static.mutation"] } }, "relay", {
		loaded: [],
		selected: [],
	}),
	handedOver: ["static.mutation"],
};

const records = () => ReviewRecords.of(changeset, { base, head });
const check = (name = "static.biome") =>
	records().check(request, { name, status: "ran", version: "2.0.0", findings: 0, notes: [] }, []);
type Claim = {
	checks?: string[];
	allowSkip?: string[];
	filled?: { name: string; status: "skipped" | "failed"; reason: string }[];
	producers?: { check: string; version?: string }[];
};
const account = (counted: SharedRecord[], claim: Claim = {}) =>
	records().account({
		checks: claim.checks ?? ["static.biome"],
		records: counted,
		filled: claim.filled ?? [],
		allowSkip: claim.allowSkip ?? [],
		producers: claim.producers ?? [],
		resolutionPolicy: null,
	});
// A round as a review writes it: the records its account counts, the account, and the round that reads them.
const accounted = (counted: SharedRecord[], claim: Parameters<typeof account>[1] = {}) => {
	const made = account(counted, claim);
	return [...counted, made, records().round([...counted, made], undefined, [], [])];
};

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
		const batch = await RelayBatch.read(await artefact(...accounted([check()])), writer);
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await batch.into(store);
		expect((await store.list(changeset)).map((each) => each.kind).sort()).toEqual(["account", "check", "round"]);
	});

	it("takes a fork's record of a check that runs the head's code", async () => {
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		await (await RelayBatch.read(await artefact(check("static.mutation")), fork)).into(store);
		expect(await store.list(changeset)).toHaveLength(1);
	});

	// The key-holding job runs every other check itself, so a fork's record of one would stand in for its own run.
	it("refuses a fork's record of a check the key-holding job runs itself", async () => {
		expect((await refusal(RelayBatch.read(await artefact(check()), fork))).code).toBe("notHeadCode");
	});

	it("refuses a round from a fork's head, so a made-up round is never added", async () => {
		const biome = check("static.mutation");
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
		expect(found.file).toBe(`${"1".repeat(64)}.json`);
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

	it.each([
		["kind", () => `changesets/${changeset}/zzkind`],
		["slot", (record: SharedRecord) => `changesets/${changeset}/${record.kind}/${"f".repeat(64)}`],
	])("refuses an empty %s directory, which holds no record to count against the bound", async (_, path) => {
		const written = accounted([check()]);
		const directory = await artefact(...written);
		await mkdir(join(directory, path(written[0]!)), { recursive: true });
		expect((await refusal(RelayBatch.read(directory, writer))).code).toBe("strayEntry");
	});

	it("refuses a round that reads a record the batch does not hold, even one the store holds", async () => {
		const biome = check();
		const round = records().round([biome], undefined, [], []);
		expect((await refusal(RelayBatch.read(await artefact(round), writer))).code).toBe("unresolvedRead");
	});

	it.each([
		["kind", { kind: "lens" }],
		["key", { key: "0".repeat(64) }],
	])("refuses a round that names a held record's ID under another %s", async (_, wrong) => {
		const biome = check();
		const round = records().round([biome], undefined, [], []).toJSON();
		const named = { kind: biome.kind, key: biome.key, id: biome.id, ...wrong };
		const forged = SharedRecord.parseEnvelope({
			...round,
			payload: { ...(round.payload as object), read: [named] },
		} as never);
		const directory = await artefact(biome);
		await plant(directory, forged.path, forged.bytes);
		expect((await refusal(RelayBatch.read(directory, writer))).code).toBe("unresolvedRead");
	});

	it("refuses a writer's batch with no round, or with two", async () => {
		expect((await refusal(RelayBatch.read(await artefact(check()), writer))).code).toBe("roundCount");
		const biome = check();
		const tsc = check("static.tsc");
		const both = await artefact(
			biome,
			tsc,
			records().round([biome], undefined, [], []),
			records().round([biome, tsc], undefined, [], []),
		);
		expect((await refusal(RelayBatch.read(both, wide))).code).toBe("roundCount");
	});

	it.each([
		["a walkthrough", (biome: SharedRecord) => records().round([biome], biome, [], [])],
		["a round it replaces", (biome: SharedRecord) => records().round([biome], undefined, ["e".repeat(64)], [])],
		["a round it follows", (biome: SharedRecord) => records().round([biome], undefined, [], ["e".repeat(64)])],
	])("refuses a round that names %s", async (_, made) => {
		const biome = check();
		expect((await refusal(RelayBatch.read(await artefact(biome, made(biome)), writer))).code).toBe("roundShape");
	});

	it("refuses a record the round does not name, and takes its triage and telemetry", async () => {
		const biome = check();
		const written = accounted([biome]);
		const round = written[2]!;
		const telemetry = records().telemetry(round, { durationMs: 5, stages: [] });
		const triage = records().triage(request, { inputCut: false });
		const batch = await RelayBatch.read(await artefact(...written, telemetry, triage), writer);
		expect(batch.records).toHaveLength(5);
		expect((await refusal(RelayBatch.read(await artefact(...written, check("static.tsc")), wide))).code).toBe(
			"unnamedRecord",
		);
		const otherRound = records().round([biome, check("static.tsc")], undefined, [], []);
		const stray = records().telemetry(otherRound, { durationMs: 5, stages: [] });
		expect((await refusal(RelayBatch.read(await artefact(...written, stray), wide))).code).toBe("unnamedRecord");
	});

	it("takes the most triage and telemetry records it allows, and refuses one more", async () => {
		const written = accounted([check()]);
		const triage = (index: number) => records().triage(index.toString(16).padStart(64, "0"), { inputCut: false });
		const at = Array.from({ length: relayLimits.extras }, (_, index) => triage(index));
		expect((await RelayBatch.read(await artefact(...written, ...at), writer)).records).toHaveLength(at.length + 3);
		const past = [...at, triage(relayLimits.extras)];
		expect((await refusal(RelayBatch.read(await artefact(...written, ...past), writer))).code).toBe("tooManyExtras");
	});

	it("refuses a writer's round that names no account, or two", async () => {
		const biome = check();
		const bare = records().round([biome], undefined, [], []);
		expect((await refusal(RelayBatch.read(await artefact(biome, bare), writer))).code).toBe("accountCount");
		const first = account([biome]);
		const second = account([biome], { allowSkip: ["static.tsc"] });
		const both = records().round([biome, first, second], undefined, [], []);
		const found = await refusal(RelayBatch.read(await artefact(biome, first, second, both), writer));
		expect(found.code).toBe("accountCount");
	});

	it.each([
		["names checks its tier does not", { checks: ["static.biome", "static.tsc"] }, [check()], "otherChecks"],
		["names a check it holds no record for", {}, [], "missingRecord"],
		["allows a skip its tier does not", { allowSkip: ["static.biome"] }, [check()], "otherSkips"],
	])("refuses a round whose account %s, by the tier's own refusal", async (_, claim, counted, code) => {
		const found = await refusal(RelayBatch.read(await artefact(...accounted(counted, claim)), writer));
		expect([found.code, found.recordCode]).toEqual(["tierAccount", code]);
	});

	describe("with a tier of lenses", () => {
		// Both lenses cover the change, and contracts may skip, as triage chose.
		const lensTier = TierAccount.of(
			{ ...defaultConfig, tiers: { relay: ["static.biome", "lens.correctness", "lens.contracts"] } },
			"relay",
			{
				loaded: ["correctness", "contracts"],
				selected: [
					{ name: "correctness", covers: ["a.ts"], band: LevelBand.of(undefined) },
					{ name: "contracts", covers: ["a.ts"], band: LevelBand.of({ floor: "skip" }) },
				],
			},
		);
		const run = { ...writer, tier: lensTier };
		const lens = () =>
			records().lens(
				{ name: "correctness", version: "0123456789ab", level: "careful", request: "e".repeat(64), probe: false },
				{ status: "unanswered", reason: "no reply" },
				[],
				{ name: "lens.correctness", status: "ran", version: "0123456789ab", level: "careful" },
			);
		const triaged = (inputCut: boolean) =>
			records().triage(request, {
				decision: {
					questionSet: { name: "lenses", version: "1" },
					decider: "recorded",
					calibrated: false,
					answers: [{ question: "contracts", distribution: { skip: 1 }, chosen: "skip" }],
				},
				inputCut,
			});
		const claim: Claim = {
			checks: ["static.biome", "lens.correctness", "lens.contracts"],
			allowSkip: ["lens.contracts"],
			filled: [{ name: "lens.contracts", status: "skipped", reason: "triage chose skip" }],
		};

		it("takes a round whose lens, triage and filled records give its account", async () => {
			const batch = await RelayBatch.read(
				await artefact(...accounted([check(), lens(), triaged(false)], claim)),
				run,
			);
			expect(batch.records).toHaveLength(5);
		});

		it("refuses triage's skip when triage's input was cut", async () => {
			const found = await refusal(
				RelayBatch.read(await artefact(...accounted([check(), lens(), triaged(true)], claim)), run),
			);
			expect([found.code, found.recordCode]).toEqual(["tierAccount", "otherSkips"]);
		});

		// A review exports each lens run as its lens ends, with no check, and again with its check once adjudication decides.
		const early = (key: string) =>
			records().lens(
				{ name: "correctness", version: "0123456789ab", level: "careful", request: key, probe: false },
				{ status: "unanswered", reason: "no reply" },
				[],
			);

		it("takes a lens run's early copy under the key of a run the round reads", async () => {
			const written = accounted([check(), lens(), triaged(false)], claim);
			const batch = await RelayBatch.read(await artefact(...written, early("e".repeat(64))), run);
			expect(batch.records).toHaveLength(6);
		});

		it("refuses an early copy under a key the round reads no run of", async () => {
			const written = accounted([check(), lens(), triaged(false)], claim);
			const stray = early("f".repeat(64));
			const found = await refusal(RelayBatch.read(await artefact(...written, stray), run));
			expect([found.code, found.file]).toEqual(["unnamedRecord", `${stray.id}.json`]);
		});

		it("refuses a second decided copy under the key of a run the round reads", async () => {
			const written = accounted([check(), lens(), triaged(false)], claim);
			const other = records().lens(
				{ name: "correctness", version: "0123456789ab", level: "careful", request: "e".repeat(64), probe: true },
				{ status: "unanswered", reason: "no reply" },
				[],
				{ name: "lens.correctness", status: "ran", version: "0123456789ab", level: "careful" },
			);
			const found = await refusal(RelayBatch.read(await artefact(...written, other), run));
			expect([found.code, found.file]).toEqual(["unnamedRecord", `${other.id}.json`]);
		});

		it("refuses an early copy under the key of a check the round reads, which is no lens run", async () => {
			const written = accounted([check(), lens(), triaged(false)], claim);
			const stray = early(written[0]!.key);
			const found = await refusal(RelayBatch.read(await artefact(...written, stray), run));
			expect([found.code, found.file]).toEqual(["unnamedRecord", `${stray.id}.json`]);
		});

		it("refuses a verification with no check under the key of a lens run the round reads", async () => {
			const written = accounted([check(), lens(), triaged(false)], claim);
			const stray = records().verification("e".repeat(64), { claims: [], dismissals: [], outcomes: [] });
			const found = await refusal(RelayBatch.read(await artefact(...written, stray), run));
			expect([found.code, found.file]).toEqual(["unnamedRecord", `${stray.id}.json`]);
		});
	});

	describe("with the verifier's check in the account", () => {
		const verified = (ran: boolean) =>
			records().verification("f".repeat(64), {
				claims: [],
				dismissals: [],
				outcomes: [],
				...(ran ? { check: { name: "verifier", status: "ran", version: verifierVersion } as const } : {}),
			});
		const claim = { checks: ["static.biome", "verifier"] };

		it("takes the verification record's check as the verifier's", async () => {
			const batch = await RelayBatch.read(await artefact(...accounted([check(), verified(true)], claim)), writer);
			expect(batch.records).toHaveLength(4);
		});

		it("refuses the verifier's place in the account when the verification decided no check", async () => {
			const found = await refusal(
				RelayBatch.read(await artefact(...accounted([check(), verified(false)], claim)), writer),
			);
			expect([found.code, found.recordCode]).toEqual(["tierAccount", "missingRecord"]);
		});
	});

	it("takes a mutation skip with leave, which its record's cause gives", async () => {
		const mutationTier = TierAccount.of({ ...defaultConfig, tiers: { relay: ["static.mutation"] } }, "relay", {
			loaded: [],
			selected: [],
		});
		const skipped = records().check(
			request,
			{ name: "static.mutation", status: "skipped", reason: "no production lines", cause: "noProductionLines" },
			[],
		);
		const claim = { checks: ["static.mutation"], allowSkip: ["static.mutation"] };
		const batch = await RelayBatch.read(await artefact(...accounted([skipped], claim)), {
			...writer,
			tier: mutationTier,
		});
		expect(batch.records).toHaveLength(3);
	});

	it("refuses an account that counts a record its round does not read", async () => {
		const biome = check();
		const triage = records().triage(request, { inputCut: false });
		const made = account([biome, triage]);
		const round = records().round([biome, made], undefined, [], []);
		expect((await refusal(RelayBatch.read(await artefact(biome, triage, made, round), writer))).code).toBe(
			"unresolvedRead",
		);
	});

	it("refuses an account that counts a record the batch does not hold", async () => {
		const biome = check();
		const made = account([biome]);
		const round = records().round([made], undefined, [], []);
		expect((await refusal(RelayBatch.read(await artefact(made, round), writer))).code).toBe("unresolvedRead");
	});

	it("names a stray entry without its name, which the head's code chose", async () => {
		const directory = await artefact(check());
		await plant(directory, "ghp_token.txt", "x");
		const found = await refusal(RelayBatch.read(directory, writer));
		expect(found.code).toBe("strayEntry");
		expect(found.file).toBe("an entry not named for a record ID");
		expect(found.message).toBe(
			"melian records relay refused the batch: an entry not named for a record ID is no record file a review's directory store writes",
		);
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

	describe("closes check names to the base's tier", () => {
		const claim = (source: string) => ({
			id: "0123456789abcdef",
			source: { check: source, version: "2.0.0" },
			verification: {
				verdict: "confirmed",
				reason: "It runs",
				executor: "llm",
				model: "a/m",
				version: verifierVersion,
			} as const,
		});
		const verification = (source: string) =>
			records().verification("f".repeat(64), {
				claims: [claim(source)],
				dismissals: [],
				outcomes: [],
				check: { name: "verifier", status: "ran", version: verifierVersion },
			});
		const lensRun = { version: "0123456789ab", level: "careful", request: "e".repeat(64), probe: false } as const;
		const unanswered = { status: "unanswered", reason: "no reply" } as const;
		const lensTier = TierAccount.of(
			{ ...defaultConfig, tiers: { relay: ["static.biome", "lens.correctness"] } },
			"relay",
			{
				loaded: ["correctness"],
				selected: [{ name: "correctness", covers: ["a.ts"], band: LevelBand.of(undefined) }],
			},
		);

		it.each([
			["a check record's", () => check("static.planted")],
			["a lens record's own", () => records().lens({ name: "planted", ...lensRun }, unanswered, [])],
			["a verification claim's source", () => verification("static.planted")],
			[
				"an account's filled record",
				() => account([], { filled: [{ name: "static.planted", status: "skipped", reason: "planted" }] }),
			],
			["an account's producer", () => account([], { producers: [{ check: "static.planted", version: "2.0.0" }] })],
		])("refuses %s name the tier does not give", async (_, made) => {
			const found = await refusal(RelayBatch.read(await artefact(made()), { ...writer, tier: lensTier }));
			expect([found.code, found.file]).toEqual(["otherCheck", `${made().id}.json`]);
		});

		it("refuses a fork's check record named outside the tier", async () => {
			expect((await refusal(RelayBatch.read(await artefact(check("static.planted")), fork))).code).toBe(
				"otherCheck",
			);
		});

		it("takes an account that filled the verifier's failed check", async () => {
			const biome = check();
			const failed = { name: "verifier", status: "failed", reason: "no route" } as const;
			const batch = await RelayBatch.read(
				await artefact(...accounted([biome], { checks: ["static.biome", "verifier"], filled: [failed] })),
				writer,
			);
			expect(batch.records).toHaveLength(3);
		});

		it("takes a verification's claims of a check the tier gives", async () => {
			const biome = check();
			const batch = await RelayBatch.read(
				await artefact(...accounted([biome, verification("static.biome")])),
				writer,
			);
			expect(batch.records).toHaveLength(4);
		});
	});

	describe("refuses an entry the store's tree never holds", () => {
		const slot = "0".repeat(64);
		const id = "1".repeat(64);
		const at = `changesets/${changeset}`;
		it.each([
			["a slot whose name has a prefix", `${at}/check/x${slot}/${id}.json`],
			["a slot whose name has a suffix", `${at}/check/${slot}x/${id}.json`],
			["a file whose name has a prefix", `${at}/check/${slot}/x${id}.json`],
			["a file whose name has a suffix", `${at}/check/${slot}/${id}.jsonx`],
			["a file in a kind folder named with a dot", `${at}/.check/${slot}/${id}.json`],
			["a file where a kind folder goes", `${at}/check`],
			["a file named for a slot where a slot folder goes", `${at}/check/${slot}`],
			["a file where the changeset's folder goes", at],
			["a file in tmp", `tmp/${id}.json`],
			["a folder beside changesets", `other/${id}.json`],
		])("%s", async (_, path) => {
			const directory = await artefact();
			await plant(directory, path, "x");
			const found = await refusal(RelayBatch.read(directory, fork));
			expect(found.code).toBe("strayEntry");
		});
	});

	it("refuses a root it cannot list as unreadable", async () => {
		const found = await refusal(RelayBatch.read(join(await scratch(), "missing"), fork));
		expect(found.code).toBe("unreadable");
	});

	it("refuses a writer's empty batch as holding no round", async () => {
		const found = await refusal(RelayBatch.read(await artefact(), writer));
		expect([found.code, found.file]).toEqual(["roundCount", "an entry not named for a record ID"]);
	});

	it("names the first record of a batch with no round", async () => {
		const biome = check();
		const found = await refusal(RelayBatch.read(await artefact(biome), writer));
		expect([found.code, found.file]).toEqual(["roundCount", `${biome.id}.json`]);
	});

	it("names one of a batch's two rounds", async () => {
		const biome = check();
		const tsc = check("static.tsc");
		const rounds = [records().round([biome], undefined, [], []), records().round([biome, tsc], undefined, [], [])];
		const found = await refusal(RelayBatch.read(await artefact(biome, tsc, ...rounds), wide));
		expect(found.code).toBe("roundCount");
		expect(rounds.map((round) => `${round.id}.json`)).toContain(found.file);
	});

	it("refuses a record keyed by its round's ID that is not the round's telemetry", async () => {
		const written = accounted([check()]);
		const round = written[2]!;
		const stray = records().verification(round.id, { claims: [], dismissals: [], outcomes: [] });
		const found = await refusal(RelayBatch.read(await artefact(...written, stray), writer));
		expect([found.code, found.file]).toEqual(["unnamedRecord", `${stray.id}.json`]);
	});

	it.each([
		[
			"bytes that are not UTF-8, before it reads them as a record",
			(bytes: string) => Buffer.concat([Buffer.from(bytes), Buffer.from([0xff])]),
			undefined,
		],
		["a byte order mark, which no record holds", (bytes: string) => `\uFEFF${bytes}`, "invalidRecord"],
	])("refuses a record file that starts or ends with %s", async (_, change, recordCode) => {
		const biome = check();
		const directory = await artefact();
		await plant(directory, biome.path, change(biome.bytes));
		const found = await refusal(RelayBatch.read(directory, fork));
		expect([found.code, found.recordCode]).toEqual(["invalidRecord", recordCode]);
	});
});
