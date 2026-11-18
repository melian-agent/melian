import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, loadConfig, type RepositorySource } from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	type Harness,
	openHarness,
	openSqliteStorage,
	runChecks,
	type Storage,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckRunRecord } from "../src/checks.ts";
import { ReviewRecords } from "../src/review-records.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

let repo: string;
let base: string;
let head: string;
let dir: string;
const opened: Harness[] = [];

beforeEach(() => {
	repo = createRepository();
	base = commit(repo, {
		"melian.yaml": lines("tiers:", "  fast: [static.biome]"),
		"src/a.ts": "export const a = 1;\n",
	});
	head = commit(repo, { "src/a.ts": "export const a = 2;\n" });
	dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-check-request-")));
});

afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	rmSync(dir, { recursive: true, force: true });
	removeRepository(repo);
});

async function checked(storage: Storage) {
	const fake = createFakeModels();
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	const harness = await openHarness(storage, {
		models: fake.models,
		registry,
		env: () => createNodeExecutionEnv(repo),
	});
	opened.push(harness);
	const root = await harness.root(context, { agent: { model: fake.ref() } });
	const changeset = await Changeset.resolve(repo, `${base}..${head}`);
	const source: RepositorySource = { kind: "revision", commit: base };
	const { config } = await loadConfig(repo, source, "");
	const run = await runChecks(
		harness,
		{ rootConversationId: root.id, changeset, config, source, tier: "fast" },
		context,
	);
	const key = (record: CheckRunRecord) =>
		ReviewRecords.of(changeset.id, changeset.revision).check(run.request, record, []).key;
	return { harness, run, keys: run.records.map(key) };
}

describe("a check run's full request key", { timeout: 120_000 }, () => {
	it("is the one an uninterrupted run gives, after the process that ran the checks ends and another resumes", async () => {
		const path = join(dir, "checks.sqlite");
		const first = await checked(await openSqliteStorage(path));
		expect(first.run.records).toMatchObject([{ name: "static.biome", status: "ran" }]);
		await first.harness.close(context);
		opened.splice(0);

		const resumed = await checked(await openSqliteStorage(path));
		const uninterrupted = await checked(createMemoryStorage());
		// The resumed process found the stored run rather than running the checks again.
		expect(resumed.run.identity).toEqual(first.run.identity);
		expect(resumed.run.records).toEqual(first.run.records);
		expect(resumed.run.request).toMatch(/^[0-9a-f]{64}$/);
		expect(resumed.run.request.slice(0, 16)).toBe(first.run.identity.policy);
		expect(resumed.run.request).toBe(first.run.request);
		expect(uninterrupted.run.request).toBe(first.run.request);
		expect(resumed.keys).toEqual(first.keys);
		expect(uninterrupted.keys).toEqual(first.keys);
	});
});
