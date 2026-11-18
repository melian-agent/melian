import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig } from "@melian-agent/core";
import {
	codeVersion,
	backgroundContext as context,
	createReviewRegistry,
	type Harness,
	openHarness,
	openSqliteStorage,
	reviewChangeset,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewIndex } from "../src/review-index.ts";
import { createRepository, gitIn, isolatedGitEnv, removeRepository } from "./fixtures/repo.ts";

const fixture = (name: string) => new URL(`./fixtures/adjudication-key-main/${name}`, import.meta.url);
const recorded = JSON.parse(readFileSync(fixture("recorded.json"), "utf8")) as {
	changeset: string;
	key: string;
	adjudication: { task: number; input: string };
};

let scratch: string;
let repo: string;
let harness: Harness;
const fake = createFakeModels();

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "melian-adjudication-key-")));
	copyFileSync(fixture("decided.sqlite"), join(scratch, "decided.sqlite"));
	repo = createRepository();
	gitIn(
		repo,
		"fetch",
		fixture("repo.bundle").pathname,
		"refs/heads/main:refs/heads/legacy-base",
		"refs/heads/feature:refs/heads/legacy-head",
	);
	harness = await openHarness(await openSqliteStorage(join(scratch, "decided.sqlite")), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
});

afterEach(async () => {
	await harness.close(context);
	vi.unstubAllEnvs();
	removeRepository(repo);
	rmSync(scratch, { recursive: true, force: true });
});

async function stored() {
	const root = await harness.root(context);
	return (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[recorded.key]!.adjudication!;
}

async function review() {
	const resolved = await Changeset.resolve(repo, "legacy-base...legacy-head");
	const input = JSON.parse(recorded.adjudication.input) as { repoRoot: string };
	return reviewChangeset({
		harness,
		changeset: Changeset.from({ ...resolved.toJSON(), id: recorded.changeset, repoRoot: input.repoRoot }),
		config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
		lenses: [],
		standards: [],
		models: fake.review,
		checks: [{ name: "static.mutation", status: "ran" }],
	});
}

it("decides main's stored verdict again once, under a key that adds the code version to the same input", async () => {
	expect(await stored()).toEqual(recorded.adjudication);

	const first = await review();

	const decided = await stored();
	expect(decided.task).not.toBe(recorded.adjudication.task);
	expect(JSON.parse(decided.input)).toEqual({
		...JSON.parse(recorded.adjudication.input),
		code: codeVersion("adjudication"),
	});
	expect(first.verdict.status).toBe("passed");

	const repeat = await review();

	expect(await stored()).toEqual(decided);
	expect(repeat.verdict.fingerprint()).toBe(first.verdict.fingerprint());
	expect(fake.provider.state.callCount).toBe(0);
});
