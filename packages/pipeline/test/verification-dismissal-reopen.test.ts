import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, MemoryRecordStore, reviewPayloads } from "@melian-agent/core";
import { afterEach, expect, it } from "vitest";
import { FindingsDocument } from "../src/findings.ts";
import { backgroundContext as context, openHarness, openSqliteStorage, type TaskId } from "../src/harness.ts";
import { createReviewRegistry, reviewChangeset } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { ReviewRecords } from "../src/review-records.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
	systemPromptOf,
} from "../src/testing.ts";
import type { VerificationInput } from "../src/verification.ts";
import { verifierMarker } from "../src/verification-instructions.ts";
import { gitIn } from "./fixtures/repo.ts";

const fixture = new URL("./fixtures/verification-dismissal-main/", import.meta.url);
const scratch: string[] = [];
afterEach(() => {
	for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const restatement = {
	file: "src/user.ts",
	line: 7,
	endLine: 8,
	rule: "null-dereference",
	severity: "P1",
	explanation: {
		what: "managerName reads name from a manager that may be undefined.",
		why: "This change dropped the optional chain, so a user without a manager throws.",
		fix: "Restore user.manager?.name with a fallback.",
	},
	failureScenario: "A user with no manager makes managerName throw on the name read.",
	evidence: [{ file: "src/user.ts", line: 8, role: "cause" }],
};

// Main's verification request named no dismissal record, and this build's names one, so main's never matches.
it("reopens a verification main showed a dismissed root, attaches nothing to it, and verifies again once", async () => {
	const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
		root: number;
		revision: string;
		dismissed: string;
		restatement: string[];
		verification: { task: number; input: string };
		taskVersion: number;
		shown: unknown[];
	};
	expect(recorded.taskVersion).toBe(4);
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-dismissal-key-repo-")));
	const state = realpathSync(mkdtempSync(join(tmpdir(), "melian-dismissal-key-state-")));
	scratch.push(repo, state);
	gitIn(repo, "init", "--quiet", "--initial-branch=scratch");
	gitIn(repo, "fetch", "--quiet", new URL("repo.bundle", fixture).pathname, "main:main", "feature:feature");
	gitIn(repo, "checkout", "--quiet", "feature");
	const file = join(state, "state.sqlite");
	copyFileSync(new URL("state.sqlite", fixture), file);

	const fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
	const harness = await openHarness(await openSqliteStorage(file), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	try {
		const root = await harness.root(context, { agent: { model: fake.ref("finder") } });
		expect(root.id).toEqual(recorded.root);
		const stored = await harness.getTask(recorded.verification.task as unknown as TaskId<unknown>, context);
		expect((stored!.input as unknown as VerificationInput).candidates.map((each) => each.dismissed)).toEqual(
			recorded.shown,
		);

		const changeset = await Changeset.resolve(repo, "main...feature");
		expect(`${changeset.revision.base}..${changeset.revision.head}`).toEqual(recorded.revision);
		const lenses = (
			await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"])
		).filter((lens) => lens.name === "correctness");
		let verifiers = 0;
		const verify = (messages: Parameters<typeof scriptVerifier>[0]) => {
			if (!messages.some((message) => message.role === "toolResult")) verifiers++;
			const prompt = systemPromptOf(messages);
			const dismissed = [...prompt.matchAll(/Dismissed d[1-9][0-9]* finding ([0-9a-f]{16})/g)].map((m) => m[1]!);
			const claims = [...prompt.matchAll(/Claim c[1-9][0-9]* finding ([0-9a-f]+)/g)].map((m) => m[1]!);
			const matches = Object.fromEntries(dismissed.map((id) => [id, "same"]));
			return scriptVerifier(
				messages,
				Object.fromEntries(claims.map((id) => [id, { verdict: "confirmed" as const, matches }])),
			);
		};
		scriptConversations(fake, [
			{
				match: lenses[0]!.instructions,
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", restatement), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: verifierMarker, replies: [verify, verify, verify, verify] },
		]);
		const finder = fake.ref("finder");
		const judge = fake.ref("judge");
		const store = new MemoryRecordStore({ payloads: reviewPayloads });
		const again = await reviewChangeset({
			harness,
			checks: [],
			changeset,
			lenses,
			standards: [],
			models: fake.review,
			records: store,
			config: {
				...defaultConfig,
				tiers: { full: ["lens.correctness"] },
				stages: { "pull-request": "full" },
				models: {
					heavy: { model: `${finder.provider}/${finder.modelId}` },
					verifier: { model: `${judge.provider}/${judge.modelId}` },
				},
			},
		});

		expect(verifiers).toBe(1);
		expect(again.verdict.dismissed.map((each) => each.id)).toEqual(recorded.restatement);
		const after = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[recorded.revision]!;
		expect(after.verification!.task).not.toBe(recorded.verification.task);
		expect(after.verification!.input).not.toBe(recorded.verification.input);
		const fresh = (await harness.getTask(after.verification!.task as unknown as TaskId<unknown>, context))!
			.input as unknown as VerificationInput;
		// main dismissed with no record store, so the dismissal is not shared, and the request names what it would hold.
		expect((await store.list(changeset.id)).filter(({ kind }) => kind === "dismissal")).toEqual([]);
		expect(again.unshared).toEqual([{ finding: recorded.dismissed, code: "madeWithoutStore" }]);
		const state = (await harness.snapshot(FindingsDocument, root.id, context))!;
		const identity = ReviewRecords.of(changeset.id, changeset.revision).dismissalIdentity(
			state,
			recorded.dismissed,
			[],
		);
		expect(identity).toMatch(/^[0-9a-f]{64}$/);
		expect(fresh.candidates.map((each) => each.dismissed?.map(({ id, record }) => [id, record]))).toEqual([
			[[recorded.dismissed, identity]],
		]);
	} finally {
		await harness.close(context);
	}
});
