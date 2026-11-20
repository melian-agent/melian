import { Changeset, KeyedRequest, loadConfig, type RepositorySource, Revision } from "@melian-agent/core";
import {
	type ConversationId,
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
import { CheckSources, ChecksDocument } from "../src/checks.ts";
import { codeVersion } from "../src/code-version.ts";
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
		expect(stampOf(findings, Revision.key(changeset.revision), "guardrails")).toEqual({
			request: made.request,
			task: await taskOf(root, made.identity.task, "guardrails"),
		});
		expect(await taskOf(root, made.identity.task, "guardrails")).toEqual(expect.any(Number));
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

	// The check task its run's own task recorded for `check`, which is what stamps that check's sightings.
	const taskOf = async (root: { readonly id: ConversationId }, run: number, check: string) =>
		(await harness.snapshot(CheckSources, root.id, String(run), context))?.tasks[check];

	// Main's build before the stamp asked for the first versions of each check, and its run's terminal commit wrote no
	// stamp. The last build before code hashes asked for the second, by hand-raised numbers and no `code`.
	it.each([
		[
			"without a stamp",
			{ guardrails: 1, "static.biome": 2, "static.tsc": 3, "static.enola": 4, "static.mutation": 2 },
		],
		[
			"under hand-raised numbers",
			{ guardrails: 1, "static.biome": 3, "static.tsc": 4, "static.enola": 5, "static.mutation": 3 },
		],
	])("never reuse a run an earlier build completed %s, so asking again stamps the sightings", async (_, before) => {
		const { made, root, changeset } = await run();
		const revision = Revision.key(changeset.revision);
		const stored = (await harness.snapshot(ChecksDocument, root.id, context))!;
		const kept = stored.requests![made.request] as Record<string, unknown>;
		// The run asks under its checks' code version, which no build with hand-raised numbers keyed.
		expect(kept.code).toBe(codeVersion("checks"));
		expect(kept).not.toHaveProperty("checks");
		const { code: _code, ...earlier } = kept;
		const old = KeyedRequest.of("check", { ...earlier, checks: before } as never).key;
		const { base, head } = changeset.revision;
		const current = `${base} ${head} fast ${made.request.slice(0, 16)} 0`;
		const task = stored.tasks[current]!;
		await root.commit(async (tx) => {
			const runs = await tx.doc(ChecksDocument, root.id);
			delete runs.tasks[current];
			delete runs.requests![made.request];
			runs.tasks[`${base} ${head} fast ${old.slice(0, 16)} 0`] = task;
			runs.requests![old] = { ...earlier, checks: before } as never;
			delete (await tx.doc(FindingsDocument, root.id)).checkRuns![revision];
		}, context);
		const again = await run();

		expect(again.made.request).not.toBe(old);
		const findings = await harness.snapshot(FindingsDocument, root.id, context);
		expect(stampOf(findings, revision, "guardrails")).toEqual({
			request: again.made.request,
			task: await taskOf(root, again.made.identity.task, "guardrails"),
		});
	});
});
