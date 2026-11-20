import {
	Changeset,
	canonicalJson,
	envelopeAllowance,
	evaluateGuardrails,
	loadConfig,
	type RepositorySource,
	Revision,
	reviewPayloads,
	SightingBudget,
	type StoredFinding,
} from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	type Harness,
	openHarness,
	readCheckRecords,
	relayLimits,
	runChecks,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FindingsDocument, producerSightings } from "../../pipeline/src/findings.ts";
import { ReviewRecords } from "../../pipeline/src/review-records.ts";
import { commit, createRepository, lines, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import { Remote } from "../../state-git/test/fixtures/remote.ts";

// Issue #605's example, scaled: each workspace manifest's notice names ten changed and ten removed scripts of 100
// characters, so 1,500 of them pass the budget with their detail and fit it with most of it left out.
const packages = 1500;
const name = (index: number) => `script-${String(index).padStart(2, "0")}-`.padEnd(100, "x");
const manifest = (scripts: Record<string, string>) => JSON.stringify({ scripts }, undefined, 2);
const all = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [name(index), "vitest --run"]));
const some = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [name(index), "true"]));
const tree = (scripts: Record<string, string>) =>
	Object.fromEntries(
		Array.from({ length: packages }, (_, index) => [
			`packages/p${String(index).padStart(4, "0")}/package.json`,
			manifest(scripts),
		]),
	);

let repo: string;
let harness: Harness;
let remote: Remote;

beforeAll(async () => {
	repo = createRepository();
	commit(repo, {
		"melian.yaml": lines("tiers:", "  fast: [guardrails]"),
		"package.json": lines('{ "workspaces": ["packages/*"] }'),
		...tree(all),
	});
	commit(repo, tree(some));
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	harness = await openHarness(createMemoryStorage(), {
		models: createFakeModels().models,
		registry,
		env: () => createNodeExecutionEnv(repo),
	});
	remote = await Remote.create();
});

afterAll(async () => {
	await harness.close(context);
	await remote.close();
	removeRepository(repo);
});

// What decides whether a finding blocks, by its ID.
const blocking = (each: readonly StoredFinding[]) =>
	Object.fromEntries(each.map(({ properties }) => [properties.id, [properties.severity, properties.resolution]]));
const ids = (each: readonly StoredFinding[]) => each.map(({ properties }) => properties.id).sort();

describe("a guardrails record past the store's limit", { timeout: 600_000 }, () => {
	it("is trimmed to fit, and the git store takes it whole with every ID, the blocking set and the allowance kept", async () => {
		const changeset = await Changeset.resolve(repo, "HEAD~1..HEAD");
		const source: RepositorySource = { kind: "revision", commit: changeset.revision.base };
		const untrimmed = await evaluateGuardrails({ repoRoot: repo, revision: changeset.revision, source });
		const notices = untrimmed.findings.map((finding) => finding.toJSON());
		expect(notices).toHaveLength(packages);
		expect(Buffer.byteLength(canonicalJson(notices))).toBeGreaterThan(SightingBudget.checkRecord.bytes);

		const { config } = await loadConfig(repo, source, "");
		const root = await harness.root(context);
		const run = await runChecks(
			harness,
			{ rootConversationId: root.id, changeset, config, source, tier: "fast" },
			context,
		);
		const state = await harness.snapshot(FindingsDocument, root.id, context);
		const sightings = producerSightings(state!, Revision.key(changeset.revision), { check: "guardrails" });
		const result = (await readCheckRecords(harness, root.id, run.identity, context)).guardrails!;
		const record = ReviewRecords.of(changeset.id, changeset.revision).check(run.request, result, sightings);

		expect(Buffer.byteLength(record.bytes)).toBeLessThanOrEqual(relayLimits.fileBytes);
		expect(ids(sightings)).toEqual(ids(notices));
		expect(blocking(sightings)).toEqual(blocking(notices));
		const left = sightings.filter(({ message, properties }) => properties.explanation.what === message.text);
		expect(left.length).toBeGreaterThan(0);
		expect(left.length).toBeLessThan(packages);
		expect(new Set(left.map(({ properties }) => properties.explanation.whyHere))).toEqual(
			new Set([`Melian left out the detail for ${left.length} more files to keep this record under its limit.`]),
		);
		// The record beside its sightings is the envelope and the check's result, which the allowance must cover.
		const sighted = Buffer.byteLength(canonicalJson((record.payload as { sightings: unknown }).sightings));
		expect(Buffer.byteLength(record.bytes) - sighted).toBeLessThanOrEqual(envelopeAllowance);
		expect(sighted).toBeLessThanOrEqual(SightingBudget.checkRecord.bytes);
		const store = await remote.open({ payloads: reviewPayloads });
		await store.add([record.toJSON()]);
		expect((await store.list(changeset.id)).map((each) => canonicalJson(each))).toEqual([record.bytes]);
	});
});
