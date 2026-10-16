import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, type Decider } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	checksExtension,
	backgroundContext as context,
	createRegistry,
	createReviewRegistry,
	defineTask,
	type JsonObject,
	openHarness,
	openSqliteStorage,
	publishExtension,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { DecisionDocument, decisionExtension } from "../src/decisions.ts";
import { PublisherDocument } from "../src/publish.ts";
import { ReviewIndex } from "../src/review-index.ts";
import * as staticRunner from "../src/static.ts";
import { TimingDocument } from "../src/task-timing.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

const recorded = JSON.parse(
	readFileSync(new URL("./fixtures/stage-telemetry-previous/tasks.json", import.meta.url), "utf8"),
) as {
	recordedBy: string;
	tasks: Record<
		string,
		{ kind: string; version: number; input: JsonObject; state: { checkpoint: { phase: string } & JsonObject } }
	>;
};
const directories: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

it.each(["melian.check", "melian.decision", "melian.adjudication", "melian.publish"])(
	"reopens the previous %s without inventing a start",
	async (kind) => {
		const repo = crashRepository();
		directories.push(repo);
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-stage-reopen-")));
		directories.push(directory);
		const path = join(directory, "state.sqlite");
		const previous = recorded.tasks[kind]!;
		const changeset = await Changeset.resolve(repo, "main...feature");
		const sample = recorded.tasks["melian.check"]!.input.changeset as {
			repoRoot: string;
			revision: { base: string; head: string };
		};
		const remapped = JSON.stringify(previous.input)
			.replaceAll(sample.repoRoot, repo)
			.replaceAll(sample.revision.base, changeset.revision.base)
			.replaceAll(sample.revision.head, changeset.revision.head);
		const input = JSON.parse(remapped) as JsonObject;
		const fake = createFakeModels();
		const first = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createRegistry(),
		});
		closes.push(() => first.close(context));
		const root = await first.root(context);
		const token = defineTask<JsonObject, { phase: string } & JsonObject, null>({
			name: kind,
			version: previous.version,
			initial: () => previous.state.checkpoint,
			phases: {
				[previous.state.checkpoint.phase]: async () => {
					throw new Error("old definition should never execute");
				},
			},
			abort: async (_task, runtime, abortContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
		});
		const id = await root.commit(async (tx) => {
			const id = await tx.createTask(token, input, { ownership: { kind: "conversation" } });
			(await tx.doc(ReviewIndex, root.id)).reviews[`${changeset.revision.base}..${changeset.revision.head}`] = {
				lenses: [],
				adjudication: { task: id, input: remapped },
			};
			const decision = input as { revision?: string; key?: string };
			if (kind === "melian.decision")
				(await tx.doc(DecisionDocument, root.id)).decisions[decision.revision!] = {
					triage: { task: id, key: decision.key! },
				};
			return id;
		}, context);
		await first.close(context);
		const registry = createReviewRegistry();
		registry.install(checksExtension);
		const decider: Decider = {
			name: "telemetry-test",
			calibrated: true,
			decide: async (request) => {
				expect(request.questions.map(({ id }) => id)).toEqual(["correctness"]);
				return { answers: [{ question: "correctness", distribution: { quick: 1 } }] };
			},
		};
		registry.install(decisionExtension(decider));
		const state = pullRequestState();
		registry.install(
			publishExtension(
				createGitHubProvider({
					owner: state.owner,
					repo: state.repo,
					token: "test-token",
					fetch: fakeGitHub(state),
				}),
			),
		);
		vi.spyOn(staticRunner, "runStaticTool").mockImplementation(async (request) => {
			expect(request.tool).toBe("mutation");
			return {
				status: "ran",
				log: { version: "2.1.0", runs: [{ tool: { driver: { name: "mutation", version: "test" } }, results: [] }] },
				notes: [],
			};
		});
		const storage = await openSqliteStorage(path);
		const second = await openHarness(storage, { models: fake.models, registry, env: undefined });
		closes.push(() => second.close(context));
		const settled = await second.waitForTask(id, context);
		expect(settled.state.outcome.status).toBe(kind === "melian.adjudication" ? "failed" : "completed");
		const record = await storage.task(id, context);
		expect(record!.version).toBe(previous.version + 1);
		const timing = await storage.findDocument(
			{
				kind: TimingDocument.definition.kind,
				scope: { kind: "conversation", conversationId: root.id },
				key: String(id),
			},
			"current",
			context,
		);
		expect(timing, "terminal timing must survive the task, without a fabricated start").toBeDefined();
		const value = (await storage.document(timing!.id, "current", context))!.value;
		expect(value.startedAt).toBeUndefined();
		expect(value.endedAt).toEqual(expect.any(Number));
		expect(fake.provider.state.callCount).toBe(0);
	},
);

it.each([
	["trustedWriters", true, "writer trust policy changed"],
	["login", "other-user", "publisher login changed"],
	["permission", "admin", "publisher permission changed"],
	["authorPermission", "write", "publisher authorPermission changed"],
])("supersedes a reopened version-2 publication when %s changes", async (field, value, reason) => {
	const previous = JSON.parse(
		readFileSync(new URL("./fixtures/stage-telemetry-previous/untrusted-publication.json", import.meta.url), "utf8"),
	) as {
		version: number;
		input: JsonObject & { publishedBy: JsonObject };
		state: { checkpoint: { phase: string } & JsonObject };
	};
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-publisher-reopen-")));
	directories.push(directory);
	const path = join(directory, "state.sqlite");
	const fake = createFakeModels();
	const first = await openHarness(await openSqliteStorage(path), { models: fake.models, registry: createRegistry() });
	closes.push(() => first.close(context));
	const root = await first.root(context);
	const token = defineTask<JsonObject, { phase: string } & JsonObject, null>({
		name: "melian.publish",
		version: previous.version,
		initial: () => previous.state.checkpoint,
		phases: {
			publish: async () => {
				throw new Error("old task must not execute");
			},
		},
		abort: async () => {
			throw new Error("old task must not abort");
		},
	});
	const id = await root.commit(async (tx) => {
		const id = await tx.createTask(token, previous.input, { ownership: { kind: "conversation" } });
		Object.assign(await tx.doc(PublisherDocument, root.id), {
			target: previous.input.target,
			publishedBy: { ...previous.input.publishedBy, [field]: value },
		});
		return id;
	}, context);
	await first.close(context);
	const state = pullRequestState();
	const fetch = vi.fn(fakeGitHub(state));
	const registry = createRegistry();
	registry.install(
		publishExtension(createGitHubProvider({ owner: state.owner, repo: state.repo, token: "test-token", fetch })),
	);
	const storage = await openSqliteStorage(path);
	const second = await openHarness(storage, { models: fake.models, registry });
	closes.push(() => second.close(context));
	const settled = await second.waitForTask(id, context);
	expect(settled.state.outcome).toEqual({ status: "completed", result: { kind: "superseded", reason } });
	expect((await storage.task(id, context))!.input).toEqual(previous.input);
	expect(fetch).not.toHaveBeenCalled();
	expect(fake.provider.state.callCount).toBe(0);
});
