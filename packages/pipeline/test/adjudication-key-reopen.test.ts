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
import { type AdjudicationResult, VerdictDocument } from "../src/adjudication.ts";
import { packagesVersion } from "../src/code-version.ts";
import type { TaskId } from "../src/harness.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { createRepository, gitIn, isolatedGitEnv, removeRepository } from "./fixtures/repo.ts";

const fixture = (name: string) => new URL(`./fixtures/adjudication-key-main/${name}`, import.meta.url);
const pending = JSON.parse(readFileSync(fixture("pending.json"), "utf8")) as { task: number };
const pending8 = JSON.parse(readFileSync(fixture("pending-8.json"), "utf8")) as {
	task: number;
	version: number;
	input: string;
};
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
	copyFileSync(fixture("pending.sqlite"), join(scratch, "pending.sqlite"));
	copyFileSync(fixture("pending-8.sqlite"), join(scratch, "pending-8.sqlite"));
	repo = createRepository();
	gitIn(
		repo,
		"fetch",
		fixture("repo.bundle").pathname,
		"refs/heads/main:refs/heads/legacy-base",
		"refs/heads/feature:refs/heads/legacy-head",
	);
});

async function open(store: string) {
	harness = await openHarness(await openSqliteStorage(join(scratch, store)), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
}

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

it("decides main's stored verdict again once, under a key that adds the code and package versions to the same input", async () => {
	await open("decided.sqlite");
	expect(await stored()).toEqual(recorded.adjudication);

	const first = await review();

	const decided = await stored();
	expect(decided.task).not.toBe(recorded.adjudication.task);
	expect(JSON.parse(decided.input)).toEqual({
		...JSON.parse(recorded.adjudication.input),
		code: codeVersion("adjudication"),
		packages: packagesVersion("adjudication"),
	});
	expect(first.verdict.status).toBe("passed");

	const repeat = await review();

	expect(await stored()).toEqual(decided);
	expect(repeat.verdict.fingerprint()).toBe(first.verdict.fingerprint());
	expect(fake.provider.state.callCount).toBe(0);
});

it("fails a version 7 task main left pending, which names no code version, and decides again on the next review", async () => {
	await open("pending.sqlite");
	expect((await stored()).task).toBe(pending.task);

	expect((await harness.waitForTask(pending.task as TaskId<AdjudicationResult>, context)).state.outcome).toEqual({
		status: "failed",
		error: {
			message:
				"another build's adjudication code, or another install's packages, created this task, so this build decides nothing; run melian review again to decide it here",
		},
	});
	const root = await harness.root(context);
	expect((await harness.snapshot(VerdictDocument, root.id, context))!.decisions![recorded.key]!.task).toBe(
		recorded.adjudication.task,
	);

	const { verdict } = await review();

	const decided = await stored();
	expect(decided.task).not.toBe(pending.task);
	expect(JSON.parse(decided.input)).toEqual({
		...JSON.parse(recorded.adjudication.input),
		code: codeVersion("adjudication"),
		packages: packagesVersion("adjudication"),
	});
	expect(verdict.status).toBe("passed");
	expect((await harness.snapshot(VerdictDocument, root.id, context))!.decisions![recorded.key]!.task).toBe(
		decided.task,
	);
	expect(fake.provider.state.callCount).toBe(0);
});

it("fails a version 8 task main left pending, which names main's code and no packages, and decides again on the next review", async () => {
	await open("pending-8.sqlite");
	expect(pending8.version).toBe(8);
	expect(await stored()).toEqual({ task: pending8.task, input: pending8.input });
	expect(JSON.parse(pending8.input)).not.toHaveProperty("packages");

	expect((await harness.waitForTask(pending8.task as TaskId<AdjudicationResult>, context)).state.outcome).toEqual({
		status: "failed",
		error: {
			message:
				"another build's adjudication code, or another install's packages, created this task, so this build decides nothing; run melian review again to decide it here",
		},
	});

	const { verdict } = await review();

	const decided = await stored();
	expect(decided.task).not.toBe(pending8.task);
	expect(JSON.parse(decided.input)).toEqual({
		...JSON.parse(recorded.adjudication.input),
		code: codeVersion("adjudication"),
		packages: packagesVersion("adjudication"),
	});
	expect(verdict.status).toBe("passed");
	const root = await harness.root(context);
	expect((await harness.snapshot(VerdictDocument, root.id, context))!.decisions![recorded.key]!.task).toBe(
		decided.task,
	);
	expect(fake.provider.state.callCount).toBe(0);
});
