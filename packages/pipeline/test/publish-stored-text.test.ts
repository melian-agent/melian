import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../src/adjudication.ts";
import {
	backgroundContext as context,
	createReviewRegistry,
	type Harness,
	openHarness,
	openReviewHarness,
	openSqliteStorage,
	type TaskId,
} from "../src/index.ts";
import { PublishedDocument, PublishHarness, publishReview } from "../src/publish.ts";
import { reviewChangeset } from "../src/review.ts";
import { createFakeModels } from "../src/testing.ts";
import { baseAndHead, gitIn, isolatedGitEnv } from "./fixtures/repo.ts";

const directories: string[] = [];
const opened: Harness[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of opened.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

// A store 8921ccb4 wrote: a decided review of tier `name`, whose Biome or tsc findings hold the tool's own text, and a
// publication parked before it ran.
async function olderStore(name: string) {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const fixture = new URL(`./fixtures/stored-text-main/${name}/`, import.meta.url);
	const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
		pending: number;
		state: FakeState;
	};
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-stored-text-")));
	directories.push(directory);
	const path = join(directory, "pending.sqlite");
	copyFileSync(new URL("pending.sqlite", fixture), path);
	const repo = join(directory, "repo");
	gitIn(directory, "clone", "--quiet", new URL("repo.bundle", fixture).pathname, repo);
	gitIn(repo, "branch", "--quiet", "main", "origin/main");
	const changeset = await Changeset.resolve(repo, "main...feature");
	const provider = createGitHubProvider({
		owner: recorded.state.owner,
		repo: recorded.state.repo,
		token: "test-token",
		fetch: fakeGitHub(recorded.state),
	});
	const posts = vi.spyOn(provider, "postReview");
	const statuses = vi.spyOn(provider, "setStatus");
	const publisher = await PublishHarness.open(await openSqliteStorage(path), createFakeModels().review, provider);
	opened.push(publisher.harness);
	return { recorded, changeset, provider, posts, statuses, path, repo, harness: publisher.harness };
}

// What a tool printed about the head's code, which an older build stored: tsc's quoted type and Biome's named variable.
const toolText = /is not assignable|This variable ghp|ghp\\?_FAKEoutsideTOKEN281/;
const posted = ({ reviews, comments, ledgers, statuses }: FakeState) =>
	JSON.stringify({ reviews, comments, ledgers, statuses });

it.each(["tsc", "biome", "mixed", "guardrails"])(
	"posts a publication an older build left pending for a %s tier with none of a tool's text",
	async (name) => {
		const { recorded, changeset, provider, harness } = await olderStore(name);
		const stored = await harness.snapshot(VerdictDocument, (await harness.root(context)).id, context);
		expect(toolText.test(JSON.stringify(stored))).toBe(name !== "guardrails");
		const done = await harness.waitForTask(recorded.pending as TaskId, context);
		expect(done.state.outcome).toMatchObject({ status: "completed", result: { kind: "published" } });
		expect(recorded.state.reviews).toHaveLength(1);
		await expect(
			publishReview({
				harness,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			}),
		).resolves.toMatchObject({ review: "1001" });
		expect(posted(recorded.state)).not.toMatch(toolText);
	},
);

it("publishes a verdict this build decided for a tier that runs tsc", async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const repo = baseAndHead({ "a.ts": "export const n = 1;\n" }, { "a.ts": "export const n = 2;\n" });
	directories.push(repo);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const state = pullRequestState();
	moveTo(state, changeset);
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test-token",
		fetch: fakeGitHub(state),
	});
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-stored-text-")));
	directories.push(directory);
	const path = join(directory, "state.sqlite");
	const fake = createFakeModels();
	const reviewing = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	await reviewing.root(context, { agent: { model: fake.ref() } });
	await reviewChangeset({
		harness: reviewing,
		changeset,
		config: { ...defaultConfig, tiers: { full: ["static.tsc"] } },
		lenses: [],
		standards: [],
		models: fake.review,
		checks: [{ name: "static.tsc", status: "ran" }],
		policy: { kind: "revision", commit: changeset.revision.base },
		origin: {
			kind: "pull-request",
			repository: { owner: state.owner, name: state.repo },
			pullRequest: 7,
			base: changeset.revision.base,
			head: changeset.revision.head,
		},
	});
	await reviewing.close(context);
	const publisher = await PublishHarness.open(await openSqliteStorage(path), fake.review, provider);
	opened.push(publisher.harness);
	await expect(
		publishReview({
			harness: publisher.harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: true,
		}),
	).resolves.toMatchObject({ review: "1001", status: { state: "success" } });
	expect(state.reviews).toHaveLength(1);
});

// Codex's scenario: a round an older build planned is left pending, a fresh review of the same revision follows, and the
// next publication must not replay the old round.
async function freshReview(name: string) {
	const older = await olderStore(name);
	await older.harness.close(context);
	opened.splice(opened.indexOf(older.harness), 1);
	const storage = await openSqliteStorage(older.path);
	const review = await openReviewHarness(storage, createFakeModels().review, { retry: false, checkout: older.repo });
	const { state } = older.recorded;
	await reviewChangeset({
		harness: review,
		changeset: older.changeset,
		config: { ...defaultConfig, tiers: { full: ["static.tsc"] } },
		lenses: [],
		standards: [],
		models: createFakeModels().review,
		policy: { kind: "revision", commit: older.changeset.revision.base },
		origin: {
			kind: "pull-request",
			repository: { owner: state.owner, name: state.repo },
			pullRequest: 7,
			base: older.changeset.revision.base,
			head: older.changeset.revision.head,
		},
	});
	await review.close(context);
	const publisher = await PublishHarness.open(
		await openSqliteStorage(older.path),
		createFakeModels().review,
		older.provider,
	);
	opened.push(publisher.harness);
	return { ...older, harness: publisher.harness };
}

it("posts a round an older build left pending with none of its tsc text, after a fresh review", async () => {
	const { recorded, changeset, provider, harness } = await freshReview("tsc-failed");
	const stored = await harness.snapshot(PublishedDocument, (await harness.root(context)).id, context);
	expect(JSON.stringify(stored?.revisions[changeset.revision.head]?.pending)).toContain("is not assignable");
	await publishReview({
		harness,
		provider,
		changeset,
		pullRequest: await provider.pullRequest(7),
		base: changeset.revision.base,
		trustedWriters: true,
	});
	expect(recorded.state.reviews.length).toBeGreaterThan(0);
	// The older build's refused request stays in the fake's call log; only what was posted counts.
	expect(posted(recorded.state)).not.toMatch(toolText);
});

it("recovers a round an older build posted before it died, and writes none of its tsc text again", async () => {
	const { recorded, changeset, provider, posts, harness } = await freshReview("tsc-posted");
	const before = structuredClone(recorded.state.reviews);
	const comments = recorded.state.comments.length;
	const stored = await harness.snapshot(PublishedDocument, (await harness.root(context)).id, context);
	expect(JSON.stringify(stored?.revisions[changeset.revision.head]?.pending)).toContain("is not assignable");
	const published = await publishReview({
		harness,
		provider,
		changeset,
		pullRequest: await provider.pullRequest(7),
		base: changeset.revision.base,
		trustedWriters: true,
	});
	expect(published).toMatchObject({ recovered: 1, review: "1003" });
	expect(posts).toHaveBeenCalledTimes(1);
	expect(recorded.state.reviews.slice(0, before.length)).toEqual(before);
	const written = {
		reviews: recorded.state.reviews.slice(before.length),
		comments: recorded.state.comments.slice(comments),
		ledgers: recorded.state.ledgers,
	};
	expect(JSON.stringify(recorded.state.comments.slice(0, comments))).toContain("is not assignable");
	expect(JSON.stringify(written)).not.toMatch(toolText);
});

it("recovers a round an older build posted, with no fresh review, and its ledger renders none of its tsc text", async () => {
	const { recorded, changeset, provider, harness } = await olderStore("tsc-posted");
	const comments = recorded.state.comments.length;
	await expect(
		publishReview({
			harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: true,
		}),
	).resolves.toMatchObject({ recovered: 1 });
	const stored = await harness.snapshot(PublishedDocument, (await harness.root(context)).id, context);
	expect(JSON.stringify(stored?.ledgerRounds)).toContain("is not assignable");
	expect(recorded.state.ledgers).toHaveLength(1);
	const { ledgers, statuses } = recorded.state;
	expect(JSON.stringify({ ledgers, statuses, comments: recorded.state.comments.slice(comments) })).not.toMatch(
		toolText,
	);
});
