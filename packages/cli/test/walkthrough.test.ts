import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import * as pipeline from "@melian-agent/pipeline";
import {
	backgroundContext as context,
	createRegistry,
	openHarness,
	openSqliteStorage,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../../pipeline/src/adjudication.ts";
import { baseAndHead, isolatedGitEnv } from "../../pipeline/test/fixtures/repo.ts";
import { publish, review } from "../src/commands.ts";
import { main } from "../src/main.ts";
import { storagePath } from "../src/repository.ts";
import * as targets from "../src/target.ts";

let repo: string;
let changeset: Changeset;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead(
		{ "src/a.ts": "export const a = 1;\n", "melian.yaml": "tiers:\n  full: [guardrails]\n" },
		{ "src/a.ts": "export const a = 2;\n" },
	);
	changeset = await Changeset.resolve(repo, "main...feature");
	const state = pullRequestState();
	moveTo(state, changeset);
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test-token",
		fetch: fakeGitHub(state),
	});
	vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
	vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({ pullRequest: await provider.pullRequest(7), changeset });
	const script = join(repo, "script.json");
	writeFileSync(script, "{}");
	env = { ...process.env, MELIAN_TEST_SCRIPT: script };
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});
async function recorded() {
	const fake = createFakeModels();
	const path = await storagePath(repo, changeset.id, env, true);
	const harness = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry: createRegistry(),
	});
	try {
		return await harness.snapshot(VerdictDocument, (await harness.root(context)).id, context);
	} finally {
		await harness.close(context);
	}
}
describe("CLI walkthrough switch", { timeout: 60_000 }, () => {
	it("skips the summariser with --no-walkthrough and keeps a summary failure out of the review exit code", async () => {
		const output: string[] = [];
		const io = {
			cwd: repo,
			env,
			stdout: (text: string) => output.push(text),
			stderr: (text: string) => output.push(text),
			color: false,
		};
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect((await recorded())?.walkthroughs).toBeUndefined();
		expect((await recorded())?.walkthroughNotes).toBeUndefined();
		expect(await review(io, "#7", { rerun: false })).toBe(0);
		expect((await recorded())?.walkthroughNotes?.[revisionKey(changeset.revision)]).toBeDefined();
		expect(output.every((text) => !text.includes("summariser"))).toBe(true);
	});
});

describe("CLI walkthrough credentials", { timeout: 60_000 }, () => {
	it("gives the summariser the review's credential unlock, to run before it asks a model", async () => {
		const summarize = vi.spyOn(pipeline, "summarizeReview").mockResolvedValue(undefined);
		const io = { cwd: repo, env, stdout: () => {}, stderr: () => {}, color: false };

		expect(await review(io, "#7", { rerun: false })).toBe(0);

		expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ unlockModels: expect.any(Function) }));
	});
});

describe("CLI publish walkthrough settings", { timeout: 60_000 }, () => {
	async function published(
		yaml: string,
		options: { walkthrough?: boolean },
		headYaml?: string,
		throughMain: { review?: boolean; publish?: boolean } = {},
		inspect?: (state: FakeState, output: string) => void,
	) {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		rmSync(repo, { recursive: true, force: true });
		repo = baseAndHead(
			{ "src/a.ts": "export const a = 1;\n", "melian.yaml": `tiers:\n  full: [guardrails]\n${yaml}` },
			{
				"src/a.ts": "export const a = 2;\n",
				...(headYaml === undefined ? {} : { "melian.yaml": `tiers:\n  full: [guardrails]\n${headYaml}` }),
			},
		);
		changeset = await Changeset.resolve(repo, "main...feature");
		const state = pullRequestState();
		moveTo(state, changeset);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
		vi.spyOn(targets, "pullRequestChangeset").mockResolvedValue(changeset);
		vi.spyOn(targets, "currentBase").mockResolvedValue(changeset.revision.base);
		vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({
			pullRequest: await provider.pullRequest(7),
			changeset,
		});
		const script = join(repo, "script.json");
		writeFileSync(script, "{}");
		env = { ...process.env, MELIAN_TEST_SCRIPT: script };
		let output = "";
		const io = {
			cwd: repo,
			env,
			stdout: (text: string) => {
				output += text;
			},
			stderr: () => {},
			color: false,
		};
		// A head that edits melian.yaml draws a policy finding, which exits 3.
		expect(
			throughMain.review
				? await main(["review", "#7", ...(options.walkthrough === false ? ["--no-walkthrough"] : [])], io)
				: await review(io, "#7", { rerun: false }),
		).toBe(headYaml === undefined ? 0 : 3);
		// publish refuses a scripted run and reads the unscripted storage, so the scripted review moves there.
		copyFileSync(await storagePath(repo, changeset.id, env, true), await storagePath(repo, changeset.id, env, false));
		const { MELIAN_TEST_SCRIPT: _, ...clean } = env;
		expect(
			throughMain.publish
				? await main(["publish", "#7", ...(options.walkthrough === false ? ["--no-walkthrough"] : [])], {
						...io,
						env: clean,
					})
				: await publish({ ...io, env: clean }, "#7", options),
		).toBe(0);
		inspect?.(state, output);
		return state.ledgers[0]!.body;
	}

	it.each([false, true])("publishes with committed base writer trust %s", async (trustedWriters) => {
		await published(
			`trust: { writers: ${trustedWriters} }\n`,
			{},
			trustedWriters ? undefined : "trust: { writers: true }\n",
			{ publish: true },
			(state, output) => {
				expect(state.statuses).toHaveLength(2);
				expect(state.statuses.every(({ state }) => state === (trustedWriters ? "success" : "error"))).toBe(true);
				if (!trustedWriters) {
					const description = "not reviewed here: writers are not trusted; a trusted host sets this status";
					expect(state.statuses.every((status) => status.description === description)).toBe(true);
					expect(output).toContain(`Status error: ${description}`);
				}
			},
		);
	});

	it("reads publish.walkthrough from the base revision and combines it with --no-walkthrough", async () => {
		const on = await published("", {});
		expect(on).toContain("Walkthrough");
		vi.restoreAllMocks();
		rmSync(repo, { recursive: true, force: true });
		expect(await published("", { walkthrough: false })).not.toContain("Walkthrough");
		vi.restoreAllMocks();
		rmSync(repo, { recursive: true, force: true });
		expect(await published("publish:\n  walkthrough:\n    enabled: false\n", {})).not.toContain("Walkthrough");
		vi.restoreAllMocks();
		rmSync(repo, { recursive: true, force: true });
		// The head turns the walkthrough back on; the base's setting still wins.
		expect(
			await published(
				"publish:\n  walkthrough:\n    enabled: false\n",
				{},
				"publish:\n  walkthrough:\n    enabled: true\n",
			),
		).not.toContain("Walkthrough");
	});

	it("stores no walkthrough when review gets --no-walkthrough from the command line", async () => {
		expect(await published("", { walkthrough: false }, undefined, { review: true })).not.toContain("Walkthrough");
		const doc = await recorded();
		expect(doc?.walkthroughs).toBeUndefined();
		expect(doc?.walkthroughNotes).toBeUndefined();
	});

	it("hides a stored walkthrough when publish gets --no-walkthrough from the command line", async () => {
		expect(await published("", { walkthrough: false }, undefined, { publish: true })).not.toContain("Walkthrough");
		expect((await recorded())?.walkthroughNotes?.[revisionKey(changeset.revision)]).toBeDefined();
	});
});
