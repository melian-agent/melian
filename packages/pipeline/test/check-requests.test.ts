import { Changeset, KeyedRequest, loadConfig, type RepositorySource, Revision } from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	type Harness,
	openHarness,
	runChecks,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChecksDocument } from "../src/checks.ts";
import { FindingsDocument, stampOf } from "../src/findings.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

let repo: string;
let harness: Harness;

beforeEach(async () => {
	repo = createRepository();
	const policy = lines(
		"tiers:",
		"  fast: [guardrails]",
		"guardrails:",
		"  forbidden-patterns:",
		"    rules:",
		"      todo: { pattern: TODO, message: Finish the TODO }",
	);
	commit(repo, { "melian.yaml": policy, "notes.txt": "ready\n" });
	commit(repo, { "notes.txt": "TODO\n" });
	const fake = createFakeModels();
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		env: () => createNodeExecutionEnv(repo),
	});
});

afterEach(async () => {
	await harness.close(context);
	removeRepository(repo);
});

async function run() {
	const changeset = await Changeset.resolve(repo, "HEAD~1..HEAD");
	const source: RepositorySource = { kind: "revision", commit: changeset.revision.base };
	const { config } = await loadConfig(repo, source, "");
	const root = await harness.root(context);
	const made = await runChecks(
		harness,
		{ rootConversationId: root.id, changeset, config, source, tier: "fast" },
		context,
	);
	return { made, root, changeset };
}

describe("the requests the checks document keeps", { timeout: 60_000 }, () => {
	it("hold a run's whole request under its key, which every check of the run stamps", async () => {
		const { made, root, changeset } = await run();
		const stored = (await harness.snapshot(ChecksDocument, root.id, context))?.requests ?? {};

		expect(Object.keys(stored)).toEqual([made.request]);
		expect(KeyedRequest.of("check", stored[made.request]).key).toBe(made.request);
		const findings = await harness.snapshot(FindingsDocument, root.id, context);
		expect(stampOf(findings, Revision.key(changeset.revision), "guardrails")).toBe(made.request);
	});

	// An entry is written once, so a repeat run under its key leaves it, and every other key, as they stand.
	it("keep the entry a repeat run under a stored key finds, and every other key's", async () => {
		const { made, root } = await run();
		const other = "f".repeat(64);
		await root.commit(async (tx) => {
			const runs = await tx.doc(ChecksDocument, root.id);
			runs.requests = { [made.request]: { kept: true }, [other]: { other: true } };
		}, context);
		const again = await run();

		expect(again.made.request).toBe(made.request);
		expect((await harness.snapshot(ChecksDocument, root.id, context))?.requests).toEqual({
			[made.request]: { kept: true },
			[other]: { other: true },
		});
	});
});
