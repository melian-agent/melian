import { rmSync } from "node:fs";
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
	Revision,
	reviewPayloads,
	SharedRecord,
} from "@melian-agent/core";
import {
	type CheckRun,
	type CheckRunRecord,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	RecordedRound,
	reviewChangeset,
} from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceCheckFindings } from "../src/findings.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

// Text an earlier build stored from Biome's output, which the head's tree does not hold, such as a login it led Biome to
// read. Before issue #281 a static finding held its tool's text; such a sighting can still sit in a host's store.
const token = "melian-test-token-5d18e2";

const checks: CheckRunRecord[] = [
	{ name: "guardrails", status: "ran", findings: 0, notes: [] },
	{ name: "static.biome", status: "ran", version: "2.5.0", findings: 1, notes: [] },
	{ name: "static.tsc", status: "ran", version: "5.9.3", findings: 0, notes: [] },
	{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
];

let repo: string;
let harness: Harness | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

// A blocking Biome finding as a build stored it. An earlier build put the tool's text in its rule, message and
// discriminator; this one writes a fixed sentence and no discriminator.
const sighting = (text: string | undefined) =>
	Finding.create({
		rule: text === undefined ? "lint/suspicious/noDebugger" : `lint/${text}`,
		message: text === undefined ? "Biome reports lint/suspicious/noDebugger here." : `Biome said ${text}`,
		file: "src/a.ts",
		startLine: 1,
		...(text === undefined ? {} : { discriminator: `Biome said ${text}` }),
		cause: "introduced",
		severity: "P1",
		explanation:
			text === undefined
				? { what: "Biome reports a rule here.", whyHere: "The change adds it.", whatToDo: "Fix it." }
				: { what: `Biome said ${text}`, whyHere: text, whatToDo: text },
		source: { check: "static.biome", version: "2.5.0" },
	});

// A check run whose request asks for `versions` of Melian's own check code, keyed as the request it carries.
const runUnder = (versions: Record<string, number>, key?: string): CheckRun => {
	const asked = KeyedRequest.of("check", { checks: versions });
	return {
		identity: { base: "b".repeat(40), head: "c".repeat(40), tier: "full", policy: asked.key.slice(0, 16), task: 7 },
		request: key ?? asked.key,
		asked,
		records: checks,
	};
};
const current = { guardrails: 1, "static.biome": 2, "static.tsc": 3, "static.enola": 2, "static.mutation": 2 };

// One review of the fixture, after the host's store already holds Biome's sighting of the revision, holding `text`.
async function review(
	store: MemoryRecordStore,
	run: { readonly checkRun?: CheckRun } = {},
	text: string | undefined = token,
) {
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	const config: MelianConfig = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
	};
	harness ??= await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	const quiet = () => fauxAssistantMessage("No findings.");
	scriptConversations(fake, [
		{ match: "You are the correctness reviewer", replies: [quiet, quiet] },
		{ match: "You are the contracts reviewer", replies: [quiet, quiet] },
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const root = await harness.root(context);
	await root.commit(
		(tx) => replaceCheckFindings(tx, root.id, "static.biome", Revision.key(changeset.revision), [sighting(text)]),
		context,
	);
	const { verdict } = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts"),
		standards: [],
		models: fake.review,
		...(run.checkRun === undefined ? { checks } : { checkRun: run.checkRun }),
		records: store,
	});
	const stored = await store.list(changeset.id);
	return { changeset, config, verdict, stored };
}

const bytes = (stored: readonly RecordEnvelope[]) => JSON.stringify(stored);
const biomeRecord = (stored: readonly RecordEnvelope[]) =>
	stored.find(
		({ kind, payload }) =>
			kind === "check" && (payload as { result: { name: string } }).result.name === "static.biome",
	)!.payload as { result: { status: string; reason?: string }; sightings: unknown[] };

function readBack(reviewed: Awaited<ReturnType<typeof review>>) {
	const rounds = reviewed.stored.filter(({ kind }) => kind === "round");
	const id = SharedRecord.parseEnvelope(rounds.at(-1)!).id;
	return RecordedRound.of(reviewed.stored, id, everyRecordCounts).verdict({
		revision: reviewed.changeset.revision,
		config: reviewed.config,
	});
}

describe("a static check's sightings, exported from a run that does not prove the text they hold is Melian's", () => {
	it.each<[string, { readonly checkRun?: CheckRun }]>([
		["bare check records", {}],
		["a run of a build whose Biome check stored its text", { checkRun: runUnder({ ...current, "static.biome": 1 }) }],
		["a run whose request is not the one it was keyed by", { checkRun: runUnder(current, "d".repeat(64)) }],
		["a run that carries no request", { checkRun: { ...runUnder(current), asked: undefined } }],
		// A caller can hand in any run beside the sightings, so a request that names current code proves nothing.
		["a run handed in whose request names current check code", { checkRun: runUnder(current) }],
	])("leave no tool text in the record, from %s", async (_, run) => {
		const reviewed = await review(new MemoryRecordStore({ payloads: reviewPayloads }), run);

		expect(reviewed.verdict.blocking).toBe(true);
		expect(bytes(reviewed.stored)).not.toContain(token);
		expect(biomeRecord(reviewed.stored)).toEqual({
			v: 1,
			result: { name: "static.biome", status: "failed", reason: "withheld", error: expect.any(String) },
			sightings: [],
		});
	});

	it("never read back as passed on another host, where the host's own verdict blocks on them", async () => {
		const reviewed = await review(new MemoryRecordStore({ payloads: reviewPayloads }));
		const verdict = await readBack(reviewed);

		expect(reviewed.verdict.status).toBe("findings");
		expect(verdict.status).toBe("not-reviewed");
		expect(verdict.notRun.map(({ name }) => name)).toContain("static.biome");
	});
});
