import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	openSqliteStorage,
	readProvenance,
	type TaskId,
} from "../src/index.ts";
import { PublishHarness, publishReview } from "../src/publish.ts";
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
	return { recorded, changeset, provider, posts, statuses, harness: publisher.harness };
}

it.each(["tsc", "biome", "mixed"])(
	"ends a publication an older build left pending, posting nothing, when its %s tier kept a tool's text",
	async (name) => {
		const { recorded, posts, statuses, harness } = await olderStore(name);
		const done = await harness.waitForTask(recorded.pending as TaskId, context);
		expect(done.state.outcome).toMatchObject({
			status: "completed",
			result: {
				kind: "superseded",
				reason: "an older Melian decided its review and kept Biome and tsc text; run melian review again",
			},
		});
		expect(posts).not.toHaveBeenCalled();
		expect(statuses).not.toHaveBeenCalled();
		expect(recorded.state.reviews).toEqual([]);
		expect(recorded.state.statuses).toEqual([]);
	},
);

it.each(["tsc", "biome", "mixed"])(
	"refuses to publish a review an older build decided, since its %s tier kept a tool's text",
	async (name) => {
		const { recorded, changeset, provider, posts, statuses, harness } = await olderStore(name);
		await harness.waitForIdle(context);
		await expect(
			publishReview({
				harness,
				provider,
				changeset,
				pullRequest: await provider.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			}),
		).rejects.toMatchObject({
			code: "notPublishable",
			message: `Melian will not publish its review of ${changeset.revision.head.slice(0, 12)} to pull request #7: an older Melian decided its review and kept Biome and tsc text; run melian review "#7" first`,
		});
		expect(posts).not.toHaveBeenCalled();
		expect(statuses).not.toHaveBeenCalled();
		expect(recorded.state.reviews).toEqual([]);
	},
);

it("publishes a review an older build decided when its tier ran neither Biome nor tsc", async () => {
	const { recorded, changeset, provider, harness } = await olderStore("guardrails");
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
	).resolves.toMatchObject({ review: "1001", status: { state: "success" } });
});

it.each([
	[["static.biome"], 2],
	[["static.tsc"], 2],
	[["guardrails", "static.tsc"], 2],
	[["guardrails"], undefined],
])(
	"records this build's stored-text version on a verdict of tier %j only when it runs Biome or tsc",
	async (full, version) => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		const repo = baseAndHead({ "a.ts": "export const n = 1;\n" }, { "a.ts": "export const n = 2;\n" });
		directories.push(repo);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const fake = createFakeModels();
		const harness = await openHarness(createMemoryStorage(), {
			models: fake.models,
			registry: createReviewRegistry(),
		});
		opened.push(harness);
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		await reviewChangeset({
			harness,
			changeset,
			config: { ...defaultConfig, tiers: { full } },
			lenses: [],
			standards: [],
			models: fake.review,
			checks: full.map((name) => ({ name, status: "ran" as const })),
			policy: { kind: "revision", commit: changeset.revision.base },
		});
		const provenance = await readProvenance(
			harness,
			root.id,
			`${changeset.revision.base}..${changeset.revision.head}`,
			context,
		);
		expect(provenance?.manifest).toEqual(full);
		expect(provenance?.storedText).toBe(version);
	},
);
