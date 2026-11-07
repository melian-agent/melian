import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { backgroundContext as context, type Harness, openSqliteStorage, type TaskId } from "../src/index.ts";
import { PublishHarness, publishReview } from "../src/publish.ts";
import { createFakeModels } from "../src/testing.ts";
import { gitIn, isolatedGitEnv } from "./fixtures/repo.ts";

const directories: string[] = [];
const opened: Harness[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of opened.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

// A store 8921ccb4 wrote: a decided review whose tsc finding holds tsc's own text, and a publication parked before it ran.
async function olderStore() {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const fixture = new URL("./fixtures/stored-text-main/main-8921ccb4/", import.meta.url);
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

it("ends a publication an older build left pending, posting nothing, when its review kept tsc's text", async () => {
	const { recorded, posts, statuses, harness } = await olderStore();
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
});

it("refuses to publish a review an older build decided, since it kept tsc's text", async () => {
	const { recorded, changeset, provider, posts, statuses, harness } = await olderStore();
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
});
