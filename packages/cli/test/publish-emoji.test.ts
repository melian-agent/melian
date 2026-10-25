import { rmSync } from "node:fs";
import { Adjudication, Changeset, defaultConfig, Finding, type FindingInput, Revision } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { backgroundContext as context, createRegistry, openHarness, openSqliteStorage } from "@melian-agent/pipeline";
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

const emojis = /\p{Emoji_Presentation}|\u{FE0F}/u;

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

// Publishes a stored review of a change whose base and head melian.yaml set `publish.emoji` as given, through a
// provider over a fake GitHub that records every post, and returns that record.
async function published(base: string, head: string): Promise<FakeState> {
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
				const key = Revision.key(changeset.revision);
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
			await new RecordedReview(harness).record(Revision.key(changeset.revision));
		} finally {
			await harness.close(context);
		}
		const io = { cwd: repo, env, stdout: () => {}, stderr: () => {}, color: false };
		expect(await publish(io, "#7", { walkthrough: false })).toBe(0);
		return state;
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

// The posted review's body and its one inline comment.
function posted(state: FakeState): string[] {
	expect(state.reviews).toHaveLength(1);
	expect(state.comments).toHaveLength(1);
	expect(state.statuses.length).toBeGreaterThan(0);
	return [state.reviews[0]!.body, state.comments[0]!.body];
}

it.each([
	["no setting", "", "publish:\n  emoji: off\n"],
	["emoji on", "publish:\n  emoji: on\n", "publish:\n  emoji: off\n"],
])("posts emojis in the comment and the review when the base has %s, whatever the head says", async (_, base, head) => {
	const state = await published(base, head);
	const [review, comment] = posted(state);
	expect(comment).toContain("\u{1F7E1} P2 | \u{270B} Needs acknowledgement | \u{1F9F9} Biome | New in this change");
	expect(review).toContain("- \u{1F535} P3 | \u{1F4AC} Advisory | \u{1F9F9} Biome | New in this change: ");
	// The commit status stays plain text whatever the setting, since the merge-group job reads it back.
	for (const status of state.statuses) expect(status.description ?? "").not.toMatch(emojis);
});

it("posts no emoji anywhere when the base's melian.yaml turns them off, whatever the head says", async () => {
	const state = await published("publish:\n  emoji: off\n", "publish:\n  emoji: on\n");
	const [review, comment] = posted(state);
	expect(comment).toContain("\nP2 | Needs acknowledgement | Biome | New in this change\n");
	expect(review).toContain("- P3 | Advisory | Biome | New in this change: ");
	for (const body of [review, comment]) expect(body).not.toMatch(emojis);
	for (const status of state.statuses) expect(status.description ?? "").not.toMatch(emojis);
});
