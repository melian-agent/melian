import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, loadConfig, type RepositorySource } from "@melian-agent/core";
import { expect, it } from "vitest";
import { AdjudicationTask } from "../src/adjudication.ts";
import { checksExtension, runChecks } from "../src/checks.ts";
import {
	backgroundContext as context,
	createNodeExecutionEnv,
	createRegistry,
	defineTask,
	type JsonObject,
	openHarness,
	openSqliteStorage,
} from "../src/harness.ts";
import { createReviewRegistry, reviewChangeset } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { createFakeModels } from "../src/testing.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

type Recorded = {
	repoRoot: string;
	base: string;
	head: string;
	verdict: string;
	task: { kind: string; version: number; input: JsonObject; initial: { phase: string } & JsonObject };
};
const recordedAt = (version: number) =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/adjudication-v${version}-static/recorded.json`, import.meta.url), "utf8"),
	) as Recorded;

// Neither older input names the review's check run. Each names another build's code, so it fails rather than count a
// static check it cannot prove, and the next review decides again under its own run.
it.each([7, 8])(
	"fails main's version %i adjudication of a counted static check, and decides again with its run",
	{
		timeout: 60_000,
	},
	async (version) => {
		const recorded = recordedAt(version);
		const repo = createRepository();
		commit(repo, {
			"melian.yaml": lines("tiers:", "  fast: [static.tsc]"),
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext" },
			}),
			"src/a.ts": lines("export const a: number = 1;"),
		});
		commit(repo, { "src/a.ts": lines("export const a: number = 'one';") });
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-adjudication-v7-")));
		const file = join(directory, "state.sqlite");
		try {
			const { revision: reviewed } = await Changeset.resolve(repo, "HEAD~1..HEAD");
			const input = JSON.parse(
				JSON.stringify(recorded.task.input)
					.replaceAll(recorded.repoRoot, repo)
					.replaceAll(recorded.base, reviewed.base)
					.replaceAll(recorded.head, reviewed.head),
			) as JsonObject;
			// Its policy fingerprint names the capture's base commit, which this repository's commits cannot reproduce, and an
			// input without one, as an older Melian stored, skips the comparison.
			expect(input.resolutionPolicy).toEqual(expect.stringMatching(/^3:/));
			delete input.resolutionPolicy;
			expect(recorded.task.version).toBe(version);
			expect(recorded.verdict).toBe("findings");
			expect(input.run).toBeUndefined();
			const revision = `${reviewed.base}..${reviewed.head}`;
			const fake = createFakeModels();
			const first = await openHarness(await openSqliteStorage(file), {
				models: fake.models,
				registry: createRegistry(),
			});
			const root = await first.root(context);
			const old = defineTask<JsonObject, { phase: string } & JsonObject, null>({
				name: recorded.task.kind,
				version: recorded.task.version,
				initial: () => recorded.task.initial,
				abort: async (_task, runtime, abortContext) => {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
				},
				phases: {
					[recorded.task.initial.phase]: async () => {
						throw new Error("old definition must not execute");
					},
				},
			});
			const id = await root.commit(async (tx) => {
				const task = await tx.createTask(old, input, { ownership: { kind: "conversation" } });
				(await tx.doc(ReviewIndex, root.id)).reviews[revision] = {
					task,
					lenses: [],
					adjudication: { task, input: "old" },
				};
				return task;
			}, context);
			await first.close(context);
			const registry = createReviewRegistry();
			registry.install(checksExtension);
			const second = await openHarness(await openSqliteStorage(file), {
				models: fake.models,
				registry,
				settings: { retry: { enabled: false } },
				env: () => createNodeExecutionEnv(repo),
			});
			try {
				second.resume();
				await second.waitForTask(id, context);
				expect(await second.getTask(id, context)).toMatchObject({
					version: AdjudicationTask.definition.version,
					input,
					state: {
						status: "terminal",
						outcome: {
							status: "failed",
							error: {
								message:
									"another build's adjudication code created this task, so this build decides nothing; run melian review again to decide it here",
							},
						},
					},
				});

				const changeset = await Changeset.resolve(repo, "HEAD~1..HEAD");
				const source: RepositorySource = { kind: "revision", commit: changeset.revision.base };
				const { config } = await loadConfig(repo, source, "");
				const checkRun = await runChecks(
					second,
					{ rootConversationId: root.id, changeset, config, source, tier: "fast" },
					context,
				);
				const { verdict } = await reviewChangeset({
					harness: second,
					changeset,
					config,
					lenses: [],
					standards: [],
					models: fake.review,
					policy: source,
					tier: "fast",
					checkRun,
				});

				const decided = (await second.snapshot(ReviewIndex, root.id, context))!.reviews[revision]!.adjudication!;
				expect(decided.task).not.toBe(id);
				expect(JSON.parse(decided.input).run).toEqual({ identity: checkRun.identity, request: checkRun.request });
				expect(verdict.status).toBe("findings");
				expect(verdict.blocking).toBe(true);
			} finally {
				await second.close(context);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
			removeRepository(repo);
		}
	},
);
