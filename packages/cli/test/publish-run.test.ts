import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Adjudication, Changeset, defaultConfig, Finding, type FindingInput } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	createRegistry,
	openHarness,
	openSqliteStorage,
	PrepareSpans,
	ReviewHarness,
	revisionKey,
	TelemetryReader,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../../pipeline/src/adjudication.ts";
import { ReviewIndex } from "../../pipeline/src/review-index.ts";
import { legacyKey, RoundWriter } from "../../pipeline/src/rounds.ts";
import { RecordedReview, recordedReviewTask } from "../../pipeline/test/fixtures/recorded-review.ts";
import { baseAndHead, isolatedGitEnv } from "../../pipeline/test/fixtures/repo.ts";
import { publish } from "../src/commands.ts";
import { main } from "../src/main.ts";
import * as repository from "../src/repository.ts";
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
async function published(
	failedRerun?: boolean,
	fails = true,
	afterChecks = false,
): Promise<{ state: FakeState; stderr: string }> {
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
		const stored = await openSqliteStorage(path);
		const harness = await openHarness(stored, { models: fake.models, registry });
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
			const revision = revisionKey(changeset.revision);
			const adjudication = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[revision]!.adjudication!
				.task;
			await root.commit(async (tx) => {
				await new RoundWriter(tx, root.id).keep(revision, adjudication);
			}, context);
			if (failedRerun === true) {
				const prepare = await PrepareSpans.start("decided", 1000, () => 3000).record(harness, revision, context);
				await TelemetryReader.open(stored).recordRun(harness, revision, legacyKey(revision), 1000, prepare);
			}
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

		if (failedRerun !== undefined) {
			const script = join(repo, "script.json");
			writeFileSync(script, "{}");
			vi.spyOn(repository, "storagePath").mockResolvedValue(path);
			const provider = await targets.gitHubFor(repo, env);
			vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({
				changeset,
				pullRequest: await provider.pullRequest(7),
			});
			if (fails) {
				if (afterChecks) {
					const step = PrepareSpans.prototype.step;
					vi.spyOn(PrepareSpans.prototype, "step").mockImplementation(function (this: PrepareSpans, name) {
						if (name === "callers") throw new Error("second review failed");
						step.call(this, name);
					});
				} else
					vi.spyOn(ReviewHarness.prototype, "resumedProviders").mockRejectedValue(
						new Error("second review failed"),
					);
			}
			expect(
				await main(["review", "#7", "--no-walkthrough"], { ...io, env: { ...env, MELIAN_TEST_SCRIPT: script } }),
			).toBe(fails ? 2 : 0);
			if (fails) expect(stderr).toContain("second review failed");
			stderr = "";
		}
		expect(await publish(io, "#7", { walkthrough: false })).toBe(0);
		return { state, stderr };
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

const run = { durationMs: 142_000, stages: [{ name: "triage", models: ["faux/scripted low"], outcome: "ran" }] };

it("shows the review's run in the ledger, from the telemetry its storage holds", async () => {
	const read = vi
		.spyOn(TelemetryReader.prototype, "runDetails")
		.mockImplementation(async (roundId) => ({ ...run, roundId }));
	const { state, stderr } = await published();
	expect(read).toHaveBeenCalledOnce();
	expect(state.ledgers[0]!.body).toContain(
		"<summary>Run details: 142 s · 0 tokens · $0.00 · faux/scripted low</summary>",
	);
	expect(stderr).toBe("");
});

it("omits the table when the bound round has no snapshot", async () => {
	const { state, stderr } = await published();
	expect(state.ledgers[0]!.body).toContain("<summary>Run details</summary>");
	expect(state.ledgers[0]!.body).not.toContain("| adjudication |");
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

it.each([true, false])(
	"publishes the decided round after a failed second review (previous spans=%s)",
	async (previousSpans) => {
		const { state, stderr } = await published(previousSpans);
		expect(state.ledgers).toHaveLength(1);
		if (previousSpans) {
			expect(state.ledgers[0]!.body).toContain("| preparation |  |  | 2.0 s | — | — | ran |  |");
			expect(state.ledgers[0]!.body).toContain("<summary>Run details: 2.0 s · 0 tokens · $0.00</summary>");
		} else {
			expect(state.ledgers[0]!.body).not.toContain("| preparation |");
		}
		expect(stderr).toBe("");
	},
);

it("replaces the preparation spans when a second review decides a verdict", async () => {
	const { state, stderr } = await published(true, false);
	expect(state.ledgers[0]!.body).toContain("| preparation |");
	expect(state.ledgers[0]!.body).not.toContain("| preparation |  |  | 2.0 s | — | — | ran |  |");
	expect(stderr).toBe("");
});

it("keeps the decided round's run after a rerun checks the head and then fails", async () => {
	const { state } = await published(true, true, true);
	expect(state.ledgers[0]!.body).toContain("Run details: 2.0 s");
	expect(state.ledgers[0]!.body).not.toContain("check guardrails");
});
