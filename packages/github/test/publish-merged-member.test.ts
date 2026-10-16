import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Changeset, ReviewProvider } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { backgroundContext as context, createMemoryStorage, type Harness, publishReview } from "@melian-agent/pipeline";
import type { LensScript } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub } from "./fixtures/fake-github.ts";
import {
	gitIn,
	isolatedGitEnv,
	moveTo,
	openPublishHarness,
	pullRequestState,
	reviewScenario,
	scenarioModels,
	scenarioRepository,
} from "./fixtures/scenario.ts";

let repo: string;
let harness: Harness | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = scenarioRepository();
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

const report = (line: number, endLine: number, rule: string, severity: string) => ({
	name: "report_finding",
	arguments: {
		file: "src/user.ts",
		line,
		endLine,
		rule,
		severity,
		explanation: { what: `${rule}.`, why: `${rule} why.`, fix: `${rule} fix.` },
		failureScenario: `${rule} scenario.`,
		evidence: [{ file: "src/user.ts", line, endLine, role: "cause" }],
	},
});
// B, from correctness, sits on line 7 alone; A, from contracts, on lines 6-7, so one hunk caused both and A speaks.
const b = report(7, 7, "null-dereference", "P2");
const a = report(6, 7, "changed-return", "P1");
const script = (correctness: unknown[], contracts: unknown[]): LensScript =>
	({
		correctness: [...(correctness.length > 0 ? [{ calls: correctness }] : []), { text: "Done." }],
		contracts: [...(contracts.length > 0 ? [{ calls: contracts }] : []), { text: "Done." }],
	}) as LensScript;

// A push that leaves src/user.ts and its hunk alone, so only the head moves.
let pushes = 0;
function push(): void {
	pushes++;
	writeFileSync(join(repo, "src/config.ts"), `export const retries = ${pushes};\nexport const timeout = 30;\n`);
	gitIn(repo, "commit", "--quiet", "--all", "-m", `push ${pushes}`);
}

// Step 27: the publish plan carries a resolution reply still owed for a report only while the verdict holds no report
// with its ID, a merged member included.
describe("a report merged under another while its resolution is owed", () => {
	it("keeps the report's thread open, and replies nothing, while the verdict holds it as a member", async () => {
		const fake = scenarioModels();
		const state = pullRequestState();
		const github = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "t",
			fetch: fakeGitHub(state),
		});
		harness = await openPublishHarness(createMemoryStorage(), fake, github);
		const publish = async (changeset: Changeset) =>
			publishReview({
				harness: harness!,
				provider: github as ReviewProvider,
				changeset,
				pullRequest: await github.pullRequest(7),
				base: changeset.revision.base,
				trustedWriters: true,
			});
		const head = async (lenses: LensScript) => {
			const { changeset, review } = await reviewScenario(repo, harness!, fake, lenses);
			const { verdict } = await review;
			moveTo(state, changeset);
			return { changeset, verdict };
		};

		await publish((await head(script([b], []))).changeset);
		const [thread] = state.comments.filter((comment) => comment.in_reply_to_id === undefined);
		expect(thread!.body).toContain("null-dereference");
		push();
		// This head reports nothing, and its round fails to answer B's thread, so the answer is owed.
		state.failReplies = true;
		await publish((await head(script([], []))).changeset).catch(() => undefined);
		state.failReplies = false;
		expect(state.comments.filter((comment) => comment.in_reply_to_id === thread!.id)).toEqual([]);
		push();
		const merged = await head(script([b], [a]));
		const [speaker] = merged.verdict.findings.block;
		expect(speaker!.properties.alsoReportedAs?.map((other) => other.ruleId)).toEqual(["null-dereference"]);

		await publish(merged.changeset);

		expect(state.comments.filter((comment) => comment.in_reply_to_id === thread!.id)).toEqual([]);
		expect(state.resolvedThreads).not.toContain(thread!.id);
	});
});
