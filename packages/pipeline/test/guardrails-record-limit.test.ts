import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	Changeset,
	canonicalJson,
	DirectoryRecordStore,
	defaultConfig,
	evaluateGuardrails,
	Finding,
	loadConfig,
	MemoryRecordStore,
	pullRequestChangesetId,
	type RepositorySource,
	Revision,
	recordLimit,
	reviewPayloads,
	SharedRecord,
	snippetHash,
	TierAccount,
} from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	type Harness,
	openHarness,
	reviewChangeset,
	runChecks,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { readFindings } from "../src/findings.ts";
import { RelayBatch, RelayRefusal } from "../src/record-relay.ts";
import { ReviewRecords, recordTooLarge } from "../src/review-records.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const changeset = pullRequestChangesetId("github", { owner: "octo", name: "repo" }, 7);
const request = "d".repeat(64);
const revision = `${base}..${head}`;
const tier = TierAccount.of({ ...defaultConfig, tiers: { relay: ["guardrails"] } }, "relay", {
	loaded: [],
	selected: [],
});
const writer = { changeset, revision, fork: false, tier, handedOver: [] };
const records = () => ReviewRecords.of(changeset, { base, head });

function sighting(pad: string): Finding {
	const path = "packages/p/package.json";
	return Finding.create({
		rule: "guardrail/policy-change-review",
		message: `Review the change to ${path}.`,
		file: path,
		startLine: 1,
		discriminator: "analyser",
		cause: "introduced",
		trigger: { file: path, index: 0, hash: snippetHash("blob:0") },
		severity: "P1",
		explanation: { what: `Changes ${path}. ${pad}`, whyHere: "Policy.", whatToDo: "Read it." },
		source: { check: "guardrails" },
		guardrail: { notice: "analyser" },
	});
}

// A guardrails check record of exactly `size` canonical bytes; past the store's limit it comes only from elsewhere,
// since the record builder trims a check to fit.
function checkOf(size: number): SharedRecord {
	const make = (pad: string) =>
		records().check(request, { name: "guardrails", status: "ran", findings: 1, notes: [] }, [sighting(pad).toJSON()]);
	const bare = Buffer.byteLength(make("").bytes);
	const within = Math.min(size, recordLimit);
	const record = grown(make("x".repeat(within - bare)), size - within);
	expect(Buffer.byteLength(record.bytes)).toBe(size);
	return record;
}

// A record past the store's limit, which `check` no longer builds: `record` with its first sighting's What `by` bytes longer.
function grown(record: SharedRecord, by: number): SharedRecord {
	const payload = record.payload as { sightings: { properties: { explanation: { what: string } } }[] };
	const [first, ...rest] = payload.sightings;
	const explanation = {
		...first!.properties.explanation,
		what: `${first!.properties.explanation.what}${"x".repeat(by)}`,
	};
	return SharedRecord.parseEnvelope({
		...record.toJSON(),
		payload: { ...payload, sightings: [{ ...first, properties: { ...first!.properties, explanation } }, ...rest] },
	});
}

const accounted = (counted: SharedRecord[]) => {
	const made = records().account({
		checks: ["guardrails"],
		records: counted,
		filled: [],
		allowSkip: [],
		producers: [{ check: "guardrails" }],
		resolutionPolicy: null,
	});
	return [...counted, made, records().round([...counted, made], undefined, [], [])];
};

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("the relay at the record limit", () => {
	it("relays a real guardrails record of exactly the limit into a store, and refuses a real one a byte past", async () => {
		const directory = await mkdtemp(join(tmpdir(), "melian-record-limit-relay-"));
		directories.push(directory);
		const at = checkOf(recordLimit);
		const store = await DirectoryRecordStore.open(directory, reviewPayloads);
		await store.add(accounted([at]).map((record) => record.toJSON()));
		await store.close();
		const batch = await RelayBatch.read(directory, writer);
		const into = new MemoryRecordStore({ payloads: reviewPayloads });
		await batch.into(into);
		const held = (await into.list(changeset)).find((each) => each.kind === "check")!;
		expect(canonicalJson(held)).toBe(at.bytes);

		const past = checkOf(recordLimit + 1);
		const other = await mkdtemp(join(tmpdir(), "melian-record-limit-relay-"));
		directories.push(other);
		const pastStore = await DirectoryRecordStore.open(other, reviewPayloads);
		await expect(pastStore.add([past.toJSON()])).rejects.toMatchObject({ code: "invalidRecord" });
		await pastStore.close();
		// A head's job that writes the file itself, at the path its bytes give.
		for (const record of accounted([past])) {
			await mkdir(dirname(join(other, record.path)), { recursive: true });
			await writeFile(join(other, record.path), record.bytes);
		}
		const error = await RelayBatch.read(other, writer).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(RelayRefusal);
		expect((error as RelayRefusal).code).toBe("fileTooLarge");
	});
});

// A guardrails review whose notices pass the store's limit even with every finding abridged: each package's name is
// 200 characters, so each notice repeats a long path in its headline, place, trigger and What to do.
const packages = 2200;
const segment = (index: number) => `p${String(index).padStart(5, "0")}-`.padEnd(200, "x");
const manifest = (scripts: Record<string, string>) => JSON.stringify({ scripts }, undefined, 2);
const tree = (scripts: Record<string, string>) =>
	Object.fromEntries(
		Array.from({ length: packages }, (_, index) => [`packages/${segment(index)}/package.json`, manifest(scripts)]),
	);

describe("a guardrails record still past the limit after trimming", { timeout: 900_000 }, () => {
	let repo: string;
	let harness: Harness;

	beforeAll(async () => {
		repo = createRepository();
		commit(repo, {
			"melian.yaml": lines("tiers:", "  fast: [guardrails]"),
			"package.json": lines('{ "workspaces": ["packages/*"] }'),
			...tree({ test: "vitest --run" }),
		});
		commit(repo, tree({ test: "true" }));
		const registry = createReviewRegistry();
		registry.install(checksExtension);
		harness = await openHarness(createMemoryStorage(), {
			models: createFakeModels().models,
			registry,
			env: () => createNodeExecutionEnv(repo),
			settings: { retry: { enabled: false } },
		});
	}, 900_000);

	afterAll(async () => {
		await harness?.close(context);
		removeRepository(repo);
	});

	it("fails the round, so the review reads not reviewed, keeps its findings whole and exports no record", async () => {
		const changeset = await Changeset.resolve(repo, "HEAD~1..HEAD");
		const source: RepositorySource = { kind: "revision", commit: changeset.revision.base };
		const untrimmed = await evaluateGuardrails({ repoRoot: repo, revision: changeset.revision, source });
		expect(untrimmed.findings).toHaveLength(packages);
		// Precondition: even abridged with a one-letter note, the sightings pass the store's limit.
		const floor = untrimmed.findings.map((finding) => finding.abridged("x").toJSON());
		expect(Buffer.byteLength(canonicalJson(floor))).toBeGreaterThan(recordLimit);

		const { config } = await loadConfig(repo, source, "");
		const root = await harness.root(context);
		const run = await runChecks(
			harness,
			{ rootConversationId: root.id, changeset, config, source, tier: "fast" },
			context,
		);
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const fake = createFakeModels();
		let outcome: { verdict?: { status: string; notRun?: readonly { name: string; reason?: string }[] } } | undefined;
		let thrown: unknown;
		try {
			outcome = (await reviewChangeset({
				harness,
				changeset,
				config,
				lenses: [],
				standards: [],
				models: fake.review,
				checkRun: run,
				tier: "fast",
				records: store,
			})) as never;
		} catch (error) {
			thrown = error;
		}
		const stored = await store.list(changeset.id);
		const report = {
			thrown:
				thrown === undefined
					? undefined
					: {
							name: (thrown as Error).name,
							code: (thrown as { code?: string }).code,
							message: (thrown as Error).message,
						},
			status: outcome?.verdict?.status,
			notRun: outcome?.verdict?.notRun?.map(({ name, reason }) => ({ name, reason })),
			stored: stored.map(({ kind }) => kind).sort(),
			localVerdicts: Object.values((await harness.snapshot(VerdictDocument, root.id, context))?.verdicts ?? {}).map(
				(each) => ({ status: each.status, blocking: each.blocking }),
			),
		};
		expect(report.thrown).toBeUndefined();
		expect(report.status).toBe("not-reviewed");
		expect(report.notRun).toEqual([{ name: "records", reason: recordTooLarge }]);
		// No verdict of findings stands beside the failed round; the whole local findings still block.
		expect(report.localVerdicts).toEqual([{ status: "not-reviewed", blocking: true }]);
		expect(report.stored).toEqual([]);
		const local = await readFindings(harness, root.id, Revision.key(changeset.revision), context);
		expect(local.filter((finding) => finding.properties.source.check === "guardrails")).toHaveLength(packages);
	});
});
