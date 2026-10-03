import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	type Harness,
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
	pullRequestState,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
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

async function killAfterReviewPosted(database: string, stateFile: string, log: string): Promise<void> {
	// The condition resolves workspace packages to their sources, as Vitest does, rather than to a stale or absent build.
	const child = spawn(
		process.execPath,
		["--conditions=@melian-agent/source", crashScript, repo, database, stateFile, log],
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
		while (!existsSync(log) || !readFileSync(log, "utf8").includes("review-posted\n")) {
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
	it("finds the review a crash left unrecorded by its marker, records it, and posts nothing twice", async () => {
		const database = join(dir, "review.sqlite");
		const stateFile = join(dir, "github.json");
		const log = join(dir, "publish.log");
		const fake = scenarioModels();
		const reviewing = pullRequestState();
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

		await killAfterReviewPosted(database, stateFile, log);

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
		});

		expect(state.reviews).toHaveLength(1);
		expect(posts(state).map((call) => call.path)).toEqual([`/repos/melian-agent/example/statuses/${head}`]);
		expect(result).toMatchObject({ review: String(state.reviews[0]!.id), posted: 0 });
		const recorded = await readPublished(harness, (await harness.root(context)).id, head, context);
		expect(recorded?.review).toBe(String(state.reviews[0]!.id));
		expect(Object.values(recorded!.threads).sort()).toEqual(
			state.comments.map((comment) => String(comment.id)).sort(),
		);
		expect(state.statuses).toEqual([expect.objectContaining({ sha: head, state: "failure" })]);
	});
});
