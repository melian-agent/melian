import { Changeset, loadConfig, type RepositorySource, Revision } from "@melian-agent/core";
import {
	type CheckRun,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replacedReason } from "../src/adjudication.ts";
import { replaceCheckFindings } from "../src/findings.ts";
import { StaticProof } from "../src/static-proof.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

const tsconfig = JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext" },
});

let repo: string;
let harness: Harness;
let fake: ReturnType<typeof createFakeModels>;

beforeEach(async () => {
	repo = createRepository();
	commit(repo, {
		"melian.yaml": lines("tiers:", "  fast: [static.tsc]"),
		"tsconfig.json": tsconfig,
		"src/a.ts": lines("export const a: number = 1;"),
	});
	commit(repo, { "src/a.ts": lines("export const a: number = 'one';") });
	fake = createFakeModels();
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		settings: { retry: { enabled: false } },
		env: () => createNodeExecutionEnv(repo),
	});
});

afterEach(async () => {
	await harness.close(context);
	removeRepository(repo);
});

async function setup() {
	const changeset = await Changeset.resolve(repo, "HEAD~1..HEAD");
	const source: RepositorySource = { kind: "revision", commit: changeset.revision.base };
	const { config } = await loadConfig(repo, source, "");
	const root = await harness.root(context);
	const check = () =>
		runChecks(harness, { rootConversationId: root.id, changeset, config, source, tier: "fast" }, context);
	const review = async (checkRun: CheckRun) =>
		(
			await reviewChangeset({
				harness,
				changeset,
				config,
				lenses: [],
				standards: [],
				models: fake.review,
				policy: source,
				tier: "fast",
				checkRun,
			})
		).verdict;
	// Another run, under another request, that started before B and commits after it with no findings.
	const stale = (task: number, request = "d".repeat(64)) =>
		root.commit(
			(tx) =>
				replaceCheckFindings(tx, root.id, "static.tsc", Revision.key(changeset.revision), [], { request, task }),
			context,
		);
	return { check, review, stale };
}

describe("a static check whose findings a stale run replaced", { timeout: 120_000 }, () => {
	it("still blocks the review whose own run found the blocker", async () => {
		const { check, review, stale } = await setup();
		const first = await check();
		expect(first.records).toMatchObject([{ name: "static.tsc", status: "ran", findings: 1 }]);
		expect((await review(first)).status).toBe("findings");

		await stale(9_999);
		const rerun = await check();
		const again = await review(rerun);

		expect(rerun.identity.task).not.toBe(first.identity.task);
		expect(rerun.records).toMatchObject([{ name: "static.tsc", status: "ran", findings: 1 }]);
		expect(again.status).toBe("findings");
		expect(again.blocking).toBe(true);
	});

	// A request that did not key everything its run read starts a new task each time, so two runs can share one key.
	it("still blocks when the stale run shares the review's request and is another task", async () => {
		const { check, review, stale } = await setup();
		const first = await check();
		await stale(9_999, first.request);

		const rerun = await check();

		expect(rerun.identity.task).not.toBe(first.identity.task);
		expect((await review(rerun)).blocking).toBe(true);
		expect((await review(first)).status).toBe("not-reviewed");
	});

	// The stale run commits after the review took its run, and before the verdict reads the findings.
	it("reads as not reviewed when the stale run's write lands after the review took its run", async () => {
		const { check, review, stale } = await setup();
		const run = await check();
		await stale(9_999);

		const verdict = await review(run);

		expect(verdict.status).toBe("not-reviewed");
		expect(verdict.notRun).toContainEqual({ name: "static.tsc", status: "failed", reason: replacedReason });
	});

	// The stale run commits after the adjudication read the findings to decide, and before the commit that records.
	it("reads as not reviewed when the stale run's write lands after the verdict was decided", async () => {
		const { check, review, stale } = await setup();
		const run = await check();
		const original = StaticProof.prototype.replaced;
		let written: Promise<unknown> | undefined;
		const spy = vi.spyOn(StaticProof.prototype, "replaced").mockImplementation(function (this: StaticProof, ...args) {
			const result = original.apply(this, args);
			written ??= stale(9_999);
			return result;
		});

		try {
			const verdict = await review(run);
			await written;

			expect(spy.mock.results[0]?.value).toEqual([]);
			expect(verdict.status).toBe("not-reviewed");
			expect(verdict.notRun).toContainEqual({ name: "static.tsc", status: "failed", reason: replacedReason });
		} finally {
			spy.mockRestore();
		}
	});
});
