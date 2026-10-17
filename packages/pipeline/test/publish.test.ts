import { rmSync } from "node:fs";
import { Adjudication, Changeset, defaultConfig, Finding } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import previous from "../../github/test/fixtures/publish-v4.json" with { type: "json" };
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
import { failedAttestations, PublisherDocument, publishExtension, publishReview } from "../src/publish.ts";
import { TaskTiming } from "../src/task-timing.ts";
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

it.each(["stale", "resumed stale", "failed", "resumed failed", "aborted", "superseded", "resumed published"])(
	"carries exactly the posted attestations when publication ends %s",
	async (mode) => {
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
			fetch: fakeGitHub(state, async (call) => {
				if (mode.endsWith("stale") && call.path.endsWith("/reviews") && call.method === "POST")
					state.pull.head.sha = "a".repeat(40);
				if (mode === "resumed published" && call.path.endsWith("/reviews") && call.method === "POST") {
					await root.commit(async (tx) => {
						(await tx.doc(VerdictDocument, root.id)).verdicts[revision] = new Adjudication({
							findings: [],
							manifest: [],
							checks: [],
							config: defaultConfig,
						})
							.adjudicate()
							.toJSON();
					}, context);
				}
			}),
		});
		const fake = createFakeModels();
		const registry = createRegistry();
		harness = await openHarness(createMemoryStorage(), { models: fake.models, registry });
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const dismissal = { by: "Maintainer", reason: "Input is constant.", at: "2026-10-17T00:00:00Z" };
		const candidate = Finding.create({
			rule: "unsafe",
			file: "src/a.ts",
			startLine: 1,
			snippet: "new",
			occurrence: 0,
			severity: "P2",
			cause: "introduced",
			message: "Unsafe input",
			source: { check: "static.example" },
			status: "dismissed",
			explanation: { what: "Unsafe", whyHere: "New", whatToDo: "Validate" },
		});
		const finding = Finding.from({ ...candidate.toJSON(), properties: { ...candidate.properties, dismissal } });
		await root.commit(async (tx) => {
			const doc = await tx.doc(VerdictDocument, root.id);
			doc.verdicts[revision] = new Adjudication({
				findings: [finding],
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
		if (mode.startsWith("resumed")) {
			const input = {
				...previous.input,
				root: root.id,
				target: {
					...previous.input.target,
					baseTip: state.pull.base.sha,
					base: changeset.revision.base,
					head: changeset.revision.head,
					revision,
				},
				lines: changeset.revision.diffLines(),
			};
			const token = defineTask<typeof input, { phase: "publish" }, never>({
				name: previous.kind,
				version: previous.version,
				initial: () => ({ ...previous.checkpoint, phase: "publish" }),
				phases: {
					publish: async () => {
						throw new Error("must use the installed publisher");
					},
				},
				abort: async () => {
					throw new Error("must use the installed publisher");
				},
			});
			await root.commit((tx) => tx.createTask(token, input, { ownership: { kind: "conversation" } }), context);
		}
		state.failLedger = mode.endsWith("failed");
		registry.install(publishExtension(provider));
		const options = {
			harness,
			provider,
			changeset,
			pullRequest: await provider.pullRequest(7),
			base: changeset.revision.base,
			trustedWriters: true,
		};
		if (mode === "superseded") {
			const start = TaskTiming.start.bind(TaskTiming);
			vi.spyOn(TaskTiming, "start").mockImplementationOnce(async (...args) => {
				const timing = await start(...args);
				await root.commit(async (tx) => {
					const publisher = await tx.doc(PublisherDocument, root.id);
					publisher.target = {
						...publisher.target!,
						head: "a".repeat(40),
						revision: `${changeset.revision.base}..${"a".repeat(40)}`,
					};
				}, context);
				return timing;
			});
		}
		let error: unknown;
		if (mode === "aborted") {
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const getStatus = provider.getStatus.bind(provider);
			vi.spyOn(provider, "getStatus").mockImplementationOnce(async (head) => {
				reached.resolve();
				await release.promise;
				return getStatus(head);
			});
			const publishing = publishReview(options).catch((failure: unknown) => failure);
			await reached.promise;
			try {
				const task = (await harness.inspect(context)).tasks.find((each) => each.record.kind === "melian.publish")!;
				const stopping = harness.abortTask(task.record.id, context);
				release.resolve();
				await stopping;
			} finally {
				release.resolve();
			}
			error = await publishing;
		} else {
			error = await publishReview(options).catch((failure: unknown) => failure);
		}
		if (mode === "resumed published") {
			expect(error).toMatchObject({
				attestations: [
					{
						revision,
						round: 1,
						dismissals: [{ id: finding.id, ruleId: finding.ruleId, path: finding.properties.path, dismissal }],
					},
					{ revision, round: 2, dismissals: [] },
				],
			});
			expect(state.reviews).toHaveLength(2);
			return;
		}
		expect(error).toBeInstanceOf(PublishError);
		expect((error as PublishError).code).toBe(
			mode.endsWith("stale") || mode === "superseded" ? "staleTarget" : "publishFailed",
		);
		expect((error as PublishError).attestations).toStrictEqual(
			mode === "aborted" || mode === "superseded"
				? []
				: [
						{
							revision,
							round: 1,
							dismissals: [{ id: finding.id, ruleId: finding.ruleId, path: finding.properties.path, dismissal }],
						},
					],
		);
		expect(state.reviews).toHaveLength(mode === "aborted" || mode === "superseded" ? 0 : 1);
		if (mode.endsWith("stale")) expect((error as PublishError).message).not.toContain("stopped before posting");
	},
);
