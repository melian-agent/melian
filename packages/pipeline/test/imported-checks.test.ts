import { Changeset, type Finding, loadConfig, type RepositorySource, Revision } from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	type Harness,
	openHarness,
	readFindings,
	runChecks,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckRunRecord } from "../src/checks.ts";
import { ImportedRecords } from "../src/imported-records.ts";
import { ReviewRecords } from "../src/review-records.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

let repo: string;
let opened: Harness[];

beforeEach(() => {
	repo = createRepository();
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	removeRepository(repo);
});

// A host of its own: a fresh store, so nothing it finds was left by another host's run.
async function host() {
	const fake = createFakeModels();
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		env: () => createNodeExecutionEnv(repo),
	});
	opened.push(harness);
	return { harness, root: await harness.root(context, { agent: { model: fake.ref() } }) };
}

const policy = lines(
	"tiers:",
	"  fast: [guardrails]",
	"guardrails:",
	"  forbidden-patterns:",
	"    rules:",
	"      todo:",
	"        pattern: TODO",
	"        message: finish it",
);

async function run(base: string, head: string, imported?: (request: string) => ImportedRecords) {
	const { harness, root } = await host();
	const changeset = await Changeset.resolve(repo, `${base}..${head}`);
	const source: RepositorySource = { kind: "revision", commit: base };
	const { config } = await loadConfig(repo, source, "");
	const input = { rootConversationId: root.id, changeset, config, source, tier: "fast" };
	// The request is the host's own, so a record keyed on it is one this host's lookup would build.
	const first = imported === undefined ? undefined : await runChecks(harness, input, context);
	const target = imported === undefined ? { harness, root } : await host();
	const records = imported?.(first!.request);
	const checked = await runChecks(
		target.harness,
		{ ...input, rootConversationId: target.root.id, ...(records === undefined ? {} : { imported: records }) },
		context,
	);
	const findings = await readFindings(target.harness, target.root.id, Revision.key({ base, head }), context);
	return { changeset, run: checked, findings, first };
}

const rules = (findings: readonly Finding[]) => findings.map((finding) => finding.ruleId);

describe("runChecks with imported records", () => {
	it("keeps a check a record of its request answers, with that record's findings, and runs nothing for it", async () => {
		const base = commit(repo, { "melian.yaml": policy });
		const head = commit(repo, { "a.ts": "// TODO\n" });
		const own = await run(base, head);
		expect(own.run.records).toEqual([{ name: "guardrails", status: "ran", findings: 1, notes: [] }]);
		const clean: CheckRunRecord = { name: "guardrails", status: "ran", findings: 0, notes: [] };
		const resumed = await run(base, head, (request) =>
			ImportedRecords.from(own.changeset.id, [
				ReviewRecords.of(own.changeset.id, { base, head }).check(request, clean, []).toJSON(),
			]),
		);
		expect(resumed.run.records).toEqual([clean]);
		expect(resumed.findings).toEqual([]);
	});

	it("writes an imported check's findings at the revision", async () => {
		const base = commit(repo, { "melian.yaml": policy });
		const head = commit(repo, { "a.ts": "// TODO\n" });
		const own = await run(base, head);
		const sightings = own.findings.map((finding) => finding.toJSON());
		const reported: CheckRunRecord = { name: "guardrails", status: "ran", findings: 1, notes: [] };
		const resumed = await run(base, head, (request) =>
			ImportedRecords.from(own.changeset.id, [
				ReviewRecords.of(own.changeset.id, { base, head }).check(request, reported, sightings).toJSON(),
			]),
		);
		expect(resumed.run.records).toEqual([reported]);
		expect(resumed.findings.map((finding) => finding.toJSON())).toEqual(sightings);
	});

	it.each([
		["another request", (request: string) => `${request.slice(0, -1)}0`, "ran"],
		["the same request, but a check that failed", (request: string) => request, "failed"],
	] as const)("runs a check whose only record is of %s", async (_, keyed, status) => {
		const base = commit(repo, { "melian.yaml": policy });
		const head = commit(repo, { "a.ts": "// TODO\n" });
		const result: CheckRunRecord =
			status === "ran"
				? { name: "guardrails", status: "ran", findings: 0, notes: [] }
				: { name: "guardrails", status: "failed", reason: "toolFailed", error: "it broke" };
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const resumed = await run(base, head, (request) =>
			ImportedRecords.from(changeset.id, [
				ReviewRecords.of(changeset.id, { base, head }).check(keyed(request), result, []).toJSON(),
			]),
		);
		expect(resumed.run.records).toEqual([{ name: "guardrails", status: "ran", findings: 1, notes: [] }]);
		expect(rules(resumed.findings)).toEqual(["guardrail/forbidden-patterns"]);
	});
});

describe("ImportedRecords.check", () => {
	const base = "a".repeat(40);
	const head = "b".repeat(40);
	const changeset = "c".repeat(64);
	const request = "d".repeat(64);
	const records = ReviewRecords.of(changeset, { base, head });
	const ran = (name: string): CheckRunRecord & { status: "ran" } => ({
		name,
		status: "ran",
		findings: 0,
		notes: [],
	});

	it("answers a check that ran, under its request, revision and name", () => {
		const imported = ImportedRecords.from(changeset, [records.check(request, ran("static.biome"), []).toJSON()]);
		expect(imported.check(request, { base, head }, "static.biome")).toEqual({
			result: ran("static.biome"),
			sightings: [],
		});
		expect(imported.check(request, { base, head }, "static.tsc")).toBeUndefined();
		expect(imported.check(request, { base: head, head }, "static.biome")).toBeUndefined();
	});

	it("never answers static.mutation, whose record is not reused", () => {
		const imported = ImportedRecords.from(changeset, [records.check(request, ran("static.mutation"), []).toJSON()]);
		expect(imported.records()).toHaveLength(1);
		expect(imported.check(request, { base, head }, "static.mutation")).toBeUndefined();
	});

	it("answers no check whose record is of a request of none", () => {
		const imported = ImportedRecords.from(changeset, [records.check(null, ran("static.biome"), []).toJSON()]);
		expect(imported.check(request, { base, head }, "static.biome")).toBeUndefined();
	});

	it.each([
		["skipped", { name: "static.biome", status: "skipped", reason: "off" }],
		["provisional", { name: "static.biome", status: "provisional", findings: 0, notes: [], reason: "later" }],
	] as const)("answers no check whose record says it %s", (_, result) => {
		const imported = ImportedRecords.from(changeset, [records.check(request, result as CheckRunRecord, []).toJSON()]);
		expect(imported.check(request, { base, head }, "static.biome")).toBeUndefined();
	});

	it("answers no check that left caller snapshots", () => {
		const snapshots = [{ commit: head, snapshotId: "s1", receipt: "r1" }];
		const imported = ImportedRecords.from(changeset, [
			records.check(request, { ...ran("static.enola"), snapshots }, []).toJSON(),
		]);
		expect(imported.check(request, { base, head }, "static.enola")).toBeUndefined();
	});
});
