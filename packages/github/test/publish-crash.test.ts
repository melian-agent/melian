import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createGitHubProvider, statusContext } from "@melian-agent/github";
import {
	backgroundContext as context,
	type Harness,
	openPublishHarness as openPublisher,
	openSqliteStorage,
	publishReview,
	readPublished,
} from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub, posts } from "./fixtures/fake-github.ts";
import {
	emptyName,
	isolatedGitEnv,
	lensScript,
	moveTo,
	nanRetries,
	openPublishHarness,
	openReviewOnlyHarness,
	pullRequestState,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
	stackOnParent,
	unsafeManager,
} from "./fixtures/scenario.ts";

const crashScript = fileURLToPath(new URL("./fixtures/publish-crash.ts", import.meta.url));

let dir: string;
let repo: string;
let harness: Harness | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	dir = mkdtempSync(join(tmpdir(), "melian-publish-crash-"));
	repo = scenarioRepository();
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

function providerFor(state: FakeState) {
	return createGitHubProvider({ owner: state.owner, repo: state.repo, token: "test-token", fetch: fakeGitHub(state) });
}

// Kills the child once it logs `event`: `review-posted` after GitHub accepted the review, or `review-requested` before.
async function killAtReview(
	database: string,
	stateFile: string,
	log: string,
	event: "review-posted" | "review-requested" = "review-posted",
): Promise<void> {
	const mode = event === "review-posted" ? "after-review" : "before-review";
	// The condition resolves workspace packages to their sources, as Vitest does, rather than to a stale or absent build.
	const child = spawn(
		process.execPath,
		["--conditions=@melian-agent/source", crashScript, repo, database, stateFile, log, mode],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<string | number | null>((resolve) =>
		child.on("exit", (code, signal) => resolve(signal ?? code)),
	);
	const deadline = Date.now() + 15_000;
	try {
		while (!existsSync(log) || !readFileSync(log, "utf8").includes(`${event}\n`)) {
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(`crash script exited before the kill point:\n${stderr}`);
			if (Date.now() > deadline) throw new Error(`crash script never reached the kill point:\n${stderr}`);
			await sleep(20);
		}
	} finally {
		child.kill("SIGKILL");
	}
	expect(await exited).toBe("SIGKILL");
}

describe("publishing across a crash", { timeout: 30_000 }, () => {
	// An installation token cannot read /user, so the rerun cannot tell who posted the review; the signature alone has
	// to prove it is Melian's.
	it.each([
		["the token can read /user", false],
		["the token cannot read /user", true],
	])(
		"finds the review a crash left unrecorded by its signed marker when %s, and posts nothing twice",
		async (_, failUser) => {
			const database = join(dir, "review.sqlite");
			const stateFile = join(dir, "github.json");
			const log = join(dir, "publish.log");
			const fake = scenarioModels();
			const reviewing = pullRequestState();
			reviewing.failUser = failUser;
			harness = await openPublishHarness(await openSqliteStorage(database), fake, providerFor(reviewing));
			const { changeset, review } = await reviewScenario(
				repo,
				harness,
				fake,
				lensScript(unsafeManager, emptyName, nanRetries),
			);
			await review;
			await harness.close(context);
			harness = undefined;
			moveTo(reviewing, changeset);
			writeFileSync(stateFile, JSON.stringify(reviewing));

			await killAtReview(database, stateFile, log);

			const state = JSON.parse(readFileSync(stateFile, "utf8")) as FakeState;
			expect(state.reviews).toHaveLength(1);
			state.calls = [];
			const github = providerFor(state);
			harness = await openPublishHarness(await openSqliteStorage(database), scenarioModels(), github);
			const head = changeset.revision.head;

			const result = await publishReview({
				harness,
				provider: github,
				changeset,
				pullRequest: await github.pullRequest(7),
				base: changeset.revision.base,
			});

			expect(state.reviews).toHaveLength(1);
			// The child set the status before it posted the review, and recorded it.
			expect(posts(state)).toEqual([]);
			expect(result).toMatchObject({ review: String(state.reviews[0]!.id), posted: 0 });
			const recorded = await readPublished(harness, (await harness.root(context)).id, head, context);
			expect(recorded?.review).toBe(String(state.reviews[0]!.id));
			expect(Object.values(recorded!.threads).sort()).toEqual(
				state.comments.map((comment) => String(comment.id)).sort(),
			);
			expect(state.statuses).toEqual([expect.objectContaining({ sha: head, state: "failure" })]);
		},
	);

	it("ends a publication a crash left from before a retarget without posting, and posts the new review once", async () => {
		stackOnParent(repo);
		const database = join(dir, "review.sqlite");
		const stateFile = join(dir, "github.json");
		const log = join(dir, "publish.log");
		const fake = scenarioModels();
		const reviewing = pullRequestState();
		harness = await openPublishHarness(await openSqliteStorage(database), fake, providerFor(reviewing));
		const first = await reviewScenario(repo, harness, fake, lensScript(unsafeManager, emptyName, nanRetries));
		await first.review;
		await harness.close(context);
		harness = undefined;
		moveTo(reviewing, first.changeset);
		writeFileSync(stateFile, JSON.stringify(reviewing));

		await killAtReview(database, stateFile, log, "review-requested");

		// The parent landed, so the pull request is retargeted onto it, keeping its head, and reviewed again.
		const state = JSON.parse(readFileSync(stateFile, "utf8")) as FakeState;
		expect(state.reviews).toEqual([]);
		state.pull.base.ref = "parent";
		const again = scenarioModels();
		harness = await openReviewOnlyHarness(await openSqliteStorage(database), again);
		const retargeted = await reviewScenario(repo, harness, again, lensScript(unsafeManager), false, {
			range: "parent...feature",
		});
		await retargeted.review;
		await harness.close(context);
		const { changeset } = retargeted;
		expect(changeset.revision.head).toBe(first.changeset.revision.head);
		expect(changeset.revision.base).not.toBe(first.changeset.revision.base);
		moveTo(state, changeset);
		state.calls = [];
		const github = providerFor(state);
		harness = (await openPublisher(await openSqliteStorage(database), scenarioModels().review, github)).harness;

		const result = await publishReview({
			harness,
			provider: github,
			changeset,
			pullRequest: await github.pullRequest(7),
			base: changeset.revision.base,
		});

		expect(result.superseded).toEqual([
			{ task: expect.any(String), reason: "its baseRef was main, and is parent now" },
		]);
		expect(state.reviews).toHaveLength(1);
		expect(state.comments.map((comment) => /`([a-z-]+)`/.exec(comment.body)?.[1])).toEqual(["null-dereference"]);
		expect(result).toMatchObject({ posted: 1, recovered: 0 });
		// The crashed run set the old verdict's status before its post; the new verdict's replaces it.
		const head = changeset.revision.head;
		expect(state.statuses.map(({ description }) => description)).toEqual([
			"3 findings, 1 blocking",
			"1 finding, 1 blocking",
		]);
		expect(state.statuses.at(-1)).toEqual({
			sha: head,
			state: "failure",
			description: "1 finding, 1 blocking",
			context: statusContext,
		});
	});
});
