import {
	Changeset,
	defaultConfig,
	everyRecordCounts,
	Finding,
	KeyedRequest,
	Lens,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	type RecordJson,
	Revision,
	reviewPayloads,
	SharedRecord,
	type StoredFinding,
} from "@melian-agent/core";
import {
	type CheckRun,
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	dismissFinding,
	type Harness,
	openHarness,
	RecordedRound,
	reviewChangeset,
	runChecks,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChecksDocument } from "../src/checks.ts";
import { DismissError } from "../src/errors.ts";
import { FindingsDocument } from "../src/findings.ts";
import { type DismissalFacts, ReviewRecords } from "../src/review-records.ts";
import { StaticProof } from "../src/static-proof.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

// Text an earlier build stored from Biome's output, such as a login it led Biome to read.
const token = "melian-test-token-0b71c4";

// A Biome sighting as a build from before issue #281 stored it, with the tool's text in its rule and discriminator.
const planted = Finding.create({
	rule: `lint/${token}`,
	message: `Biome said ${token}`,
	file: "src/a.ts",
	startLine: 2,
	discriminator: `Biome said ${token}`,
	cause: "introduced",
	severity: "P1",
	explanation: { what: `Biome said ${token}`, whyHere: token, whatToDo: token },
	source: { check: "static.biome", version: "2.5.15" },
});

let repo: string;
let harness: Harness;
let fake: ReturnType<typeof createFakeModels>;
let config: MelianConfig;

beforeEach(async () => {
	vi.stubEnv("MELIAN_STATE_DIR", undefined);
	repo = createRepository();
	commit(repo, { "src/a.ts": "export const a = 1;\n" });
	commit(repo, { "src/a.ts": lines("debugger;", "export const a = 2;") });
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	config = {
		...defaultConfig,
		tiers: { ...defaultConfig.tiers, full: ["static.biome", "lens.correctness"] },
		models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
	};
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		env: () => createNodeExecutionEnv(repo),
		settings: { retry: { enabled: false } },
	});
});

afterEach(async () => {
	await harness.close(context);
	vi.unstubAllEnvs();
	removeRepository(repo);
});

// Runs the checks as a host does, lets `between` write into the store, then reviews with the run it returns, or that
// run, and exports.
async function round(
	between: (
		root: Awaited<ReturnType<Harness["root"]>>,
		revision: string,
		run: CheckRun,
	) => Promise<CheckRun | undefined>,
) {
	const changeset = await Changeset.resolve(repo, "HEAD~1..HEAD");
	const root = await harness.root(context, { agent: { model: fake.ref() } });
	const run: CheckRun = await runChecks(
		harness,
		{
			rootConversationId: root.id,
			changeset,
			config,
			source: { kind: "revision", commit: changeset.revision.base },
			tier: "full",
		},
		context,
	);
	const handed = (await between(root, Revision.key(changeset.revision), run)) ?? run;
	const quiet = () => fauxAssistantMessage("No findings.");
	scriptConversations(fake, [{ match: "You are the correctness reviewer", replies: [quiet, quiet] }]);
	const store = new MemoryRecordStore({ payloads: reviewPayloads });
	const { verdict } = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness"),
		standards: [],
		models: fake.review,
		checkRun: handed,
		records: store,
	});
	return { changeset, verdict, root, store, stored: await store.list(changeset.id) };
}

const biome = (stored: readonly RecordEnvelope[]) =>
	stored.find(
		({ kind, payload }) =>
			kind === "check" && (payload as { result: { name: string } }).result.name === "static.biome",
	)!.payload as { result: { status: string; reason?: string }; sightings: unknown[] };

describe("a static check's sightings, beside the run a host made of the same revision", { timeout: 120_000 }, () => {
	it("are shared when that run's terminal commit wrote them all", async () => {
		const { stored } = await round(async () => {});

		expect(biome(stored).result).toMatchObject({ status: "ran" });
		expect(biome(stored).sightings).toHaveLength(1);
	});

	it("are withheld when a sighting an older build stored sits beside them", async () => {
		const reviewed = await round(async (root, revision) => {
			await root.commit((tx) => upsertFinding(tx, root.id, planted, revision), context);
		});

		expect(reviewed.verdict.blocking).toBe(true);
		expect(JSON.stringify(reviewed.stored)).not.toContain(token);
		expect(biome(reviewed.stored)).toEqual({
			v: 1,
			result: { name: "static.biome", status: "failed", reason: "withheld", error: expect.any(String) },
			sightings: [],
		});
		const id = SharedRecord.parseEnvelope(reviewed.stored.filter(({ kind }) => kind === "round").at(-1)!).id;
		const read = await RecordedRound.of(reviewed.stored, id, everyRecordCounts).verdict({
			revision: reviewed.changeset.revision,
			config,
		});
		expect(read.status).toBe("not-reviewed");
	});

	// A caller can pair one run's records with another request, or a request can share a run's 16-character task key.
	it("are withheld when the run handed in names a request the store keeps that did not write them", async () => {
		let other = "";
		const reviewed = await round(async (root, _, run) => {
			const kept = (await harness.snapshot(ChecksDocument, root.id, context))!.requests![run.request]!;
			const asked = KeyedRequest.of("check", { ...(kept as Record<string, RecordJson>), host: "another" });
			other = asked.key;
			await root.commit(async (tx) => {
				(await tx.doc(ChecksDocument, root.id)).requests![asked.key] = asked.request;
			}, context);
			return { ...run, request: asked.key };
		});

		expect((await StaticProof.read(harness, reviewed.root.id, context)).asks("static.biome", other)).toBe(true);
		expect(biome(reviewed.stored)).toEqual({
			v: 1,
			result: { name: "static.biome", status: "failed", reason: "withheld", error: expect.any(String) },
			sightings: [],
		});
	});
});

describe("a dismissal of a static finding whose sighting its run stamped", { timeout: 120_000 }, () => {
	// The dismissal as the findings document keeps it, with what a dismissal record needs.
	async function dismissed(reviewed: Awaited<ReturnType<typeof round>>): Promise<DismissalFacts> {
		const { root, changeset } = reviewed;
		const revision = Revision.key(changeset.revision);
		const before = await harness.snapshot(FindingsDocument, root.id, context);
		const [id] = Object.keys(before!.items);
		await root.commit(
			(tx) =>
				dismissFinding(
					tx,
					root.id,
					id!,
					{ by: "maintainer", reason: "Intended.", at: "2026-11-16" },
					revision,
					"P1",
				),
			context,
		);
		const { lifecycle } = (await harness.snapshot(FindingsDocument, root.id, context))!.items[id!]!;
		const sighting = lifecycle.dismissedSighting!;
		return {
			finding: id!,
			by: lifecycle.dismissedBy!,
			reason: lifecycle.dismissedReason!,
			at: lifecycle.dismissedAt!,
			severity: lifecycle.dismissedSeverity!,
			sighting: {
				revision: sighting.revision,
				finding: Finding.from({
					...sighting.sighting,
					properties: { ...sighting.sighting.properties, status: "new" },
				} as unknown as StoredFinding).toJSON(),
				...(sighting.run === undefined ? {} : { run: sighting.run }),
			},
			rounds: [],
			trigger: lifecycle.dismissedTrigger!,
		};
	}

	it("is shared, without the run's key, beside the round a reader reads", async () => {
		const reviewed = await round(async () => {});
		const facts = await dismissed(reviewed);
		const proof = await StaticProof.read(harness, reviewed.root.id, context);
		const record = ReviewRecords.of(reviewed.changeset.id, reviewed.changeset.revision).dismissal(facts, proof);

		expect(facts.sighting.run).toMatch(/^[0-9a-f]{64}$/);
		expect(record.kind).toBe("dismissal");
		expect(JSON.stringify(record.toJSON())).not.toContain(facts.sighting.run!);
		await reviewed.store.add([record.toJSON()]);
		const stored = await reviewed.store.list(reviewed.changeset.id);
		expect(stored.filter(({ kind }) => kind === "dismissal")).toHaveLength(1);
		const id = SharedRecord.parseEnvelope(stored.filter(({ kind }) => kind === "round").at(-1)!).id;
		const read = await RecordedRound.of(stored, id, everyRecordCounts).verdict({
			revision: reviewed.changeset.revision,
			config,
		});
		// Today's reader reads no dismissal record, so the finding still blocks there; issue #481 reads it as dismissed.
		expect(read.status).toBe("findings");
	});

	it("is refused when the stamp it kept names no request the store holds as code that stores no tool text", async () => {
		const reviewed = await round(async () => {});
		const facts = await dismissed(reviewed);
		const records = ReviewRecords.of(reviewed.changeset.id, reviewed.changeset.revision);
		const proof = await StaticProof.read(harness, reviewed.root.id, context);
		const { run: _, ...unstamped } = facts.sighting;

		for (const [given, by] of [
			[facts, undefined],
			[{ ...facts, sighting: unstamped }, proof],
			[{ ...facts, sighting: { ...facts.sighting, run: "d".repeat(64) } }, proof],
		] as const)
			expect(() => records.dismissal(given, by)).toThrow(
				expect.objectContaining({ constructor: DismissError, code: "unprovenRun", finding: facts.finding }),
			);
	});
});
