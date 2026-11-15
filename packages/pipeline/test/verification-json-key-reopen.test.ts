import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens } from "@melian-agent/core";
import { afterEach, expect, it } from "vitest";
import { backgroundContext as context, openHarness, openSqliteStorage } from "../src/harness.ts";
import { createReviewRegistry, reviewChangeset } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
} from "../src/testing.ts";
import { verifierMarker } from "../src/verification-instructions.ts";
import { gitIn } from "./fixtures/repo.ts";
import { crashFinding } from "./fixtures/review-scenario.ts";

const fixture = new URL("./fixtures/verification-json-key-main/", import.meta.url);
const scratch: string[] = [];
afterEach(() => {
	for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Main keyed a stored verification by its request's JSON text, and this build keys it by a hash, so main's never matches.
it("reopens a verification main keyed by its JSON text, attaches nothing to it, and verifies again once", async () => {
	const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
		root: number;
		revision: string;
		verification: { task: number; input: string };
	};
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-json-key-repo-")));
	const state = realpathSync(mkdtempSync(join(tmpdir(), "melian-json-key-state-")));
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
		const before = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[recorded.revision];
		expect(before!.verification).toEqual(recorded.verification);

		const changeset = await Changeset.resolve(repo, "main...feature");
		expect(`${gitIn(repo, "rev-parse", "main")}..${gitIn(repo, "rev-parse", "feature")}`).toEqual(recorded.revision);
		const lenses = (
			await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"])
		).filter((lens) => lens.name === "correctness");
		let verifiers = 0;
		scriptConversations(fake, [
			{
				match: lenses[0]!.instructions,
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{
				match: verifierMarker,
				replies: [
					(messages) => {
						verifiers++;
						return scriptVerifier(messages);
					},
					(messages) => scriptVerifier(messages),
				],
			},
		]);
		const finder = fake.ref("finder");
		const judge = fake.ref("judge");
		await reviewChangeset({
			harness,
			checks: [],
			changeset,
			lenses,
			standards: [],
			models: fake.review,
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

		expect(verifiers).toEqual(1);
		const after = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[recorded.revision]!.verification!;
		expect(after.task).not.toEqual(recorded.verification.task);
		expect(after.input).toMatch(/^[0-9a-f]{64}$/);
	} finally {
		await harness.close(context);
	}
});
