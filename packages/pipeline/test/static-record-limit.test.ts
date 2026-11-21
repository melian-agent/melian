import {
	Changeset,
	canonicalJson,
	loadConfig,
	MemoryRecordStore,
	type RepositorySource,
	reviewPayloads,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

// Biome's findings on 12,000 `debugger` lines, under a long directory name, take about 9 MB of sightings: past the store's
// 4 MiB limit even with every finding's detail left out.
const files = 60;
const perFile = 200;
const directory = "src/".padEnd(200, "d");
const source = (index: number) =>
	lines(...Array.from({ length: perFile }, (_, line) => `debugger; // ${index}-${line}`));
const tree = () =>
	Object.fromEntries(Array.from({ length: files }, (_, index) => [`${directory}/f${index}.ts`, source(index)]));

describe("a static check record past the limit", { timeout: 900_000 }, () => {
	let repo: string;
	let harness: Harness;

	beforeAll(async () => {
		repo = createRepository();
		commit(repo, { "melian.yaml": lines("tiers:", "  fast: [static.biome]"), "src/keep.ts": "export {};\n" });
		commit(repo, tree());
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

	it("fails the static check, so the review reads not reviewed and its records export", async () => {
		const changeset = await Changeset.resolve(repo, "HEAD~1..HEAD");
		const policy: RepositorySource = { kind: "revision", commit: changeset.revision.base };
		const { config } = await loadConfig(repo, policy, "");
		const root = await harness.root(context);
		const run = await runChecks(
			harness,
			{ rootConversationId: root.id, changeset, config, source: policy, tier: "fast" },
			context,
		);
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		let outcome: { verdict?: { status: string; notRun?: readonly { name: string; reason?: string }[] } } | undefined;
		let thrown: unknown;
		try {
			outcome = (await reviewChangeset({
				harness,
				changeset,
				config,
				lenses: [],
				standards: [],
				models: createFakeModels().review,
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
					: { code: (thrown as { code?: string }).code, message: (thrown as Error).message },
			status: outcome?.verdict?.status,
			notRun: outcome?.verdict?.notRun?.map(({ name, reason }) => ({ name, reason })),
			stored: stored.map(({ kind }) => kind).sort(),
			localVerdicts: Object.values((await harness.snapshot(VerdictDocument, root.id, context))?.verdicts ?? {}).map(
				(each) => ({ status: each.status, blocking: each.blocking }),
			),
		};
		expect(report.thrown).toBeUndefined();
		expect(report.status).toBe("not-reviewed");
		expect(report.notRun).toEqual([{ name: "static.biome", reason: "recordTooLarge" }]);
		// No verdict of findings stands beside the failed check.
		expect(report.localVerdicts).toEqual([{ status: "not-reviewed", blocking: false }]);
		expect(report.stored).toEqual(["account", "check", "round"]);
		const check = stored.find((each) => each.kind === "check")!;
		expect(check.payload).toMatchObject({ result: { name: "static.biome", status: "failed" }, sightings: [] });
		expect(canonicalJson(stored)).not.toContain(directory);
	});
});
