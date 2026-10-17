import { rmSync } from "node:fs";
import { Adjudication, Changeset, defaultConfig, Finding } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	createRegistry,
	defineTask,
	openHarness,
	openPublishHarness,
	openSqliteStorage,
	publishReview,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import taskV3 from "../../github/test/fixtures/publish-v3.json" with { type: "json" };
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../../pipeline/src/adjudication.ts";
import { PublishedDocument, PublisherDocument } from "../../pipeline/src/publish.ts";
import { baseAndHead, isolatedGitEnv } from "../../pipeline/test/fixtures/repo.ts";
import { publish } from "../src/commands.ts";
import { storagePath } from "../src/repository.ts";
import * as targets from "../src/target.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it.each([
	{ failUser: false },
	{ failUser: false, failPermission: true },
	{ failUser: true },
	{ failUser: false, legacy: true },
	{ failUser: false, resume: "post" },
	{ failUser: false, resume: "post", refuseCurrent: true },
	{ failUser: true, resume: "post", refuseCurrent: true },
	{ failUser: false, resume: "post", legacy: true },
	{ failUser: false, resume: "task" },
	{ failUser: false, resume: "task", refuseResumed: true },
	{ failUser: false, resume: "recover" },
])("prints every carried dismissal it attests: %j", async (scenario) => {
	const { failUser, resume, legacy, refuseCurrent, refuseResumed, failPermission } = scenario;
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const repo = baseAndHead({ "src/a.ts": "old\n" }, { "src/a.ts": "new\n" });
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const state = pullRequestState();
		moveTo(state, changeset);
		state.failUser = failUser;
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		const originalPost = provider.postReview.bind(provider);
		vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
		vi.spyOn(targets, "pullRequestChangeset").mockResolvedValue(changeset);
		vi.spyOn(targets, "currentBase").mockResolvedValue(changeset.revision.base);
		const fake = createFakeModels();
		const env = { ...process.env, MELIAN_TEST_SCRIPT: undefined };
		const path = await storagePath(repo, changeset.id, env, false);
		const harness = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createRegistry(),
		});
		const created = Finding.create({
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
		const dismissed = legacy
			? created
			: Finding.from({
					...created.toJSON(),
					properties: {
						...created.properties,
						dismissal: {
							by: "Maintainer <private@example.invalid>",
							at: "2026-10-17T00:00:00Z",
							reason: "Reviewed\u001b[31m input.",
						},
					},
				});
		try {
			const root = await harness.root(context, { agent: { model: fake.ref() } });
			await root.commit(async (tx) => {
				const doc = await tx.doc(VerdictDocument, root.id);
				const key = revisionKey(changeset.revision);
				doc.verdicts[key] = new Adjudication({
					findings: [dismissed],
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
		} finally {
			await harness.close(context);
		}
		let earlier: Finding | undefined;
		if (resume !== undefined) {
			earlier = Finding.create({
				rule: "prior",
				file: "src/a.ts",
				startLine: 1,
				snippet: "old",
				occurrence: 0,
				severity: "P2",
				cause: "introduced",
				message: "Earlier objection",
				source: { check: "static.example" },
				status: "dismissed",
				explanation: { what: "Earlier", whyHere: "New", whatToDo: "Validate" },
			});
			earlier = legacy
				? earlier
				: Finding.from({
						...earlier.toJSON(),
						properties: {
							...earlier.properties,
							dismissal: {
								by: "Earlier maintainer",
								at: "2026-10-16T00:00:00Z",
								reason: "Earlier reason.",
							},
						},
					});
			const opened = await openPublishHarness(await openSqliteStorage(path), fake.review, provider);
			try {
				const root = await opened.harness.root(context);
				const key = revisionKey(changeset.revision);
				const current = (await opened.harness.snapshot(VerdictDocument, root.id, context))!.verdicts[key]!;
				await root.commit(async (tx) => {
					(await tx.doc(VerdictDocument, root.id)).verdicts[key] = new Adjudication({
						findings: [earlier!],
						manifest: [],
						checks: [],
						config: defaultConfig,
					})
						.adjudicate()
						.toJSON();
				}, context);
				const post = provider.postReview.bind(provider);
				vi.spyOn(provider, "postReview").mockImplementationOnce(async (draft) => {
					if (resume === "recover") await post(draft);
					throw new Error("interrupted round");
				});
				await expect(
					publishReview({
						harness: opened.harness,
						provider,
						changeset,
						pullRequest: await provider.pullRequest(7),
						base: changeset.revision.base,
						trustedWriters: true,
					}),
				).rejects.toThrow("interrupted round");
				await root.commit(async (tx) => {
					(await tx.doc(VerdictDocument, root.id)).verdicts[key] = current;
					if (resume === "task") {
						const recorded = await tx.doc(PublisherDocument, root.id);
						const input = {
							...taskV3.input,
							root: root.id,
							target: recorded.target!,
							publishedBy: recorded.publishedBy!,
						};
						const token = defineTask<typeof input, { phase: "publish" }, never>({
							name: taskV3.kind,
							version: taskV3.version,
							initial: () => ({ phase: "publish" }),
							phases: {
								publish: async () => {
									throw new Error("must migrate");
								},
							},
							abort: async () => {
								throw new Error("must migrate");
							},
						});
						await tx.createTask(token, input, { ownership: { kind: "conversation" } });
					}
				}, context);
			} finally {
				await opened.close(context);
			}
		}
		const output: string[] = [];
		const io = { cwd: repo, env, stdout: (text: string) => output.push(text), stderr: () => {}, color: false };
		if (failPermission) {
			vi.spyOn(provider, "permission").mockRejectedValueOnce(new Error("permission read failed"));
			await expect(publish(io, "#7")).rejects.toThrow("permission read failed");
			expect(output).toEqual([]);
		}
		if (refuseCurrent || refuseResumed) {
			let posts = 0;
			vi.spyOn(provider, "postReview").mockImplementation(async (draft) => {
				if (++posts === 2) throw new Error("refused current round");
				return originalPost(draft);
			});
		}
		if (refuseCurrent) {
			await expect(publish(io, "#7")).rejects.toThrow("refused current round");
			expect(state.reviews).toHaveLength(1);
			expect(state.reviews[0]!.body).toContain(earlier!.id);
			expect(output.join("")).toContain(earlier!.id);
			expect(output.join("")).toContain("Earlier reason.");
		}
		expect(await publish(io, "#7")).toBe(0);
		expect(output.join("")).toContain("Attested dismissals:");
		if (earlier !== undefined) {
			expect(output.join("")).toContain(earlier.id);
			expect(output.join("")).toContain(legacy ? "No reason stored." : "Earlier reason.");
			expect(output.join("")).toContain(`Revision ${revisionKey(changeset.revision)}, round 1`);
			expect(output.join("")).toContain(`Revision ${revisionKey(changeset.revision)}, round 2`);
		}
		for (const expected of [
			dismissed.id,
			"unsafe",
			"src/a.ts",
			...(legacy
				? ["by unknown at unknown: No reason stored."]
				: ["Maintainer <private@example.invalid>", "2026-10-17T00:00:00Z", "Reviewed\\u001b[31m input."]),
		])
			expect(output.join("")).toContain(expected);
		expect(output.join("")).not.toContain("\u001b");
		expect(output.join("").split(dismissed.id)).toHaveLength(2);
		expect(output.join("")).toContain("Status success: 0 findings, 1 dismissed");
		const reopened = await openPublishHarness(await openSqliteStorage(path), fake.review, provider);
		try {
			const root = await reopened.harness.root(context);
			await root.commit(async (tx) => {
				delete (await tx.doc(PublishedDocument, root.id)).revisions[changeset.revision.head]!.rounds;
			}, context);
		} finally {
			await reopened.close(context);
		}
		output.length = 0;
		expect(await publish(io, "#7")).toBe(0);
		expect(output.join("")).toContain(dismissed.id);
		expect(output.join("")).toContain(`round ${resume === undefined ? 1 : 2}`);
		expect(output.join("")).toContain(revisionKey(changeset.revision));
		expect(state.reviews).toHaveLength(resume === undefined ? 1 : 2);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
