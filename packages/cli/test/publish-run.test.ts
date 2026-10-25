import { rmSync } from "node:fs";
import { Adjudication, Changeset, defaultConfig, Finding, type FindingInput } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	createRegistry,
	openHarness,
	openSqliteStorage,
	revisionKey,
	TelemetryReader,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../../pipeline/src/adjudication.ts";
import { RecordedReview, recordedReviewTask } from "../../pipeline/test/fixtures/recorded-review.ts";
import { baseAndHead, isolatedGitEnv } from "../../pipeline/test/fixtures/repo.ts";
import { publish } from "../src/commands.ts";
import { storagePath } from "../src/repository.ts";
import * as targets from "../src/target.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const finding = (input: Partial<FindingInput>): Finding =>
	Finding.create({
		rule: "unsafe",
		file: "src/a.ts",
		startLine: 1,
		snippet: "new",
		occurrence: 0,
		severity: "P2",
		cause: "introduced",
		message: "Unsafe input",
		source: { check: "static.biome" },
		explanation: { what: "Unsafe", whyHere: "New", whatToDo: "Validate" },
		...input,
	});

// Publishes a stored review through a provider over a fake GitHub, and returns what it posted and what publish said
// on standard error.
async function published(): Promise<{ state: FakeState; stderr: string }> {
	const base = "";
	const head = "";
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const repo = baseAndHead(
		{ "melian.yaml": `${base}tiers: { full: [guardrails] }\n`, "src/a.ts": "old\n" },
		{ "melian.yaml": `${head}tiers: { full: [guardrails] }\n`, "src/a.ts": "new\n" },
	);
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const state = pullRequestState();
		moveTo(state, changeset);
		// gitHubFor's provider, over the fake GitHub, with whatever options publish passes it.
		vi.spyOn(targets, "gitHubFor").mockImplementation(async (_cwd, _env, options = {}) =>
			createGitHubProvider({
				owner: state.owner,
				repo: state.repo,
				token: "t",
				fetch: fakeGitHub(state),
				...options,
			}),
		);
		vi.spyOn(targets, "pullRequestChangeset").mockResolvedValue(changeset);
		vi.spyOn(targets, "currentBase").mockResolvedValue(changeset.revision.base);
		const fake = createFakeModels();
		const env = { ...process.env, MELIAN_TEST_SCRIPT: undefined };
		const registry = createRegistry();
		registry.install({ name: "test.recorded-review", tasks: [recordedReviewTask] });
		const path = await storagePath(repo, changeset.id, env, false);
		const harness = await openHarness(await openSqliteStorage(path), { models: fake.models, registry });
		try {
			const root = await harness.root(context, { agent: { model: fake.ref() } });
			await root.commit(async (tx) => {
				const doc = await tx.doc(VerdictDocument, root.id);
				const key = revisionKey(changeset.revision);
				doc.verdicts[key] = new Adjudication({
					findings: [finding({}), finding({ rule: "style", severity: "P3", message: "Style", snippet: "x" })],
					manifest: [],
					checks: [],
					config: defaultConfig,
				})
					.adjudicate()
					.toJSON();
				doc.provenance = {
					[key]: {
						kind: "pull-request",
						manifest: [],
						lenses: [],
						repository: { owner: state.owner, name: state.repo },
						pullRequest: 7,
						base: changeset.revision.base,
						head: changeset.revision.head,
						policy: `revision:${changeset.revision.base}`,
					},
				};
			}, context);
			await new RecordedReview(harness).record(revisionKey(changeset.revision));
		} finally {
			await harness.close(context);
		}
		let stderr = "";
		const io = {
			cwd: repo,
			env,
			stdout: () => {},
			stderr: (text: string) => {
				stderr += text;
			},
			color: false,
		};
		expect(await publish(io, "#7", { walkthrough: false })).toBe(0);
		return { state, stderr };
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

const run = { durationMs: 142_000, stages: [{ name: "triage", models: ["faux/scripted low"], outcome: "ran" }] };

it("shows the review's run in the ledger, from the telemetry its storage holds", async () => {
	const read = vi.spyOn(TelemetryReader.prototype, "runDetails").mockResolvedValue(run);
	const { state, stderr } = await published();
	expect(read).toHaveBeenCalledOnce();
	expect(state.ledgers[0]!.body).toContain(
		"<summary>Run details: 142 s · 0 tokens · $0.00 · faux/scripted low</summary>",
	);
	expect(stderr).toBe("");
});

it("reads the stages the storage holds, without a review time when no spans recorded one", async () => {
	const { state, stderr } = await published();
	expect(state.ledgers[0]!.body).toContain("<summary>Run details: 0 tokens · $0.00</summary>");
	expect(state.ledgers[0]!.body).toContain("| adjudication |");
	expect(stderr).toBe("");
});

it("still posts its ledger when the telemetry cannot be read, and says why", async () => {
	vi.spyOn(TelemetryReader.prototype, "runDetails").mockRejectedValue(new Error("newer \u001b[2J version"));
	const { state, stderr } = await published();
	expect(state.ledgers[0]!.body).toContain("<summary>Run details</summary>");
	expect(stderr).toBe("melian: Run details unavailable: newer \\u001b[2J version\n");
});

it("says why in plain text when what failed was not an Error", async () => {
	vi.spyOn(TelemetryReader.prototype, "runDetails").mockRejectedValue("refused");
	const { stderr } = await published();
	expect(stderr).toBe("melian: Run details unavailable: refused\n");
});
