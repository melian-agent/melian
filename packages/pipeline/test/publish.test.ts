import { rmSync } from "node:fs";
import { Adjudication, Changeset, defaultConfig, Finding } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../src/adjudication.ts";
import { PublishError } from "../src/errors.ts";
import { revisionKey } from "../src/findings.ts";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineTask,
	type Harness,
	openHarness,
	type TaskId,
} from "../src/harness.ts";
import { failedAttestations, publishExtension, publishReview } from "../src/publish.ts";
import { createFakeModels } from "../src/testing.ts";
import { baseAndHead, isolatedGitEnv } from "./fixtures/repo.ts";

let repo: string | undefined;
let harness: Harness | undefined;

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
	repo = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it.each(["current", "pending", "failed task"])(
	"returns a legacy dismissal without an undefined field after %s publication",
	async (scenario) => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		repo = baseAndHead({ "src/a.ts": "old\n" }, { "src/a.ts": "new\n" });
		const changeset = await Changeset.resolve(repo, "main...feature");
		const revision = revisionKey(changeset.revision);
		const state = pullRequestState();
		moveTo(state, changeset);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		const fake = createFakeModels();
		const storage = createMemoryStorage();
		const registry = createRegistry();
		harness = await openHarness(storage, { models: fake.models, registry });
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const dismissed = Finding.create({
			rule: "legacy",
			file: "src/a.ts",
			startLine: 1,
			snippet: "new",
			occurrence: 0,
			severity: "P2",
			cause: "introduced",
			message: "Legacy dismissal",
			source: { check: "static.example" },
			status: "dismissed",
			explanation: { what: "Unsafe", whyHere: "New", whatToDo: "Validate" },
		});
		await root.commit(async (tx) => {
			const doc = await tx.doc(VerdictDocument, root.id);
			doc.verdicts[revision] = new Adjudication({
				findings: [dismissed],
				manifest: [],
				checks: [],
				config: defaultConfig,
			})
				.adjudicate()
				.toJSON();
			doc.provenance = {
				[revision]: {
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
		let resumedTask: TaskId | undefined;
		if (scenario === "failed task") {
			const input = {
				root: root.id,
				target: {
					repository: `${state.owner}/${state.repo}`,
					pullRequest: 7,
					baseRef: state.pull.base.ref,
					baseTip: state.pull.base.sha,
					base: changeset.revision.base,
					head: changeset.revision.head,
					revision,
				},
				publishedBy: { trustedWriters: true },
				lines: changeset.revision.diffLines(),
			};
			const task = defineTask<typeof input, { phase: "publish" }, never>({
				name: "melian.publish",
				version: 4,
				initial: () => ({ phase: "publish" }),
				phases: {
					publish: async () => {
						throw new Error("must use the installed publication task");
					},
				},
				abort: async () => {
					throw new Error("must use the installed publication task");
				},
			});
			resumedTask = await root.commit(
				(tx) => tx.createTask(task, input, { ownership: { kind: "conversation" } }),
				context,
			);
		}
		if (scenario !== "current")
			vi.spyOn(provider, "postReview").mockRejectedValueOnce(new Error("interrupted round"));
		registry.install(publishExtension(provider));
		const options = {
			harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: true,
		};
		if (scenario === "pending") await expect(publishReview(options)).rejects.toThrow("interrupted round");
		const result = await publishReview(options);
		expect(result.attestations).toStrictEqual([
			{
				revision,
				round: 1,
				dismissals: [{ id: dismissed.id, ruleId: "legacy", path: "src/a.ts" }],
			},
		]);
		if (resumedTask !== undefined)
			expect((await harness.getTask(resumedTask, context))!.state).toMatchObject({
				status: "terminal",
				outcome: { status: "failed", error: { message: "interrupted round" } },
			});
		expect(state.reviews).toHaveLength(1);
	},
);

it("reads a failed task’s legacy diagnostics without inventing attestations", () => {
	expect(failedAttestations(undefined)).toEqual([]);
	expect(failedAttestations({})).toEqual([]);
});

it("carries no attestations on a refusal before a round posts", () => {
	expect(new PublishError("notReviewed", "No review.", { pullRequest: 7, revision: "A" }).attestations).toEqual([]);
});
