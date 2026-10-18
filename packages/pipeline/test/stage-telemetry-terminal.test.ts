import { readFileSync, rmSync } from "node:fs";
import { Changeset, type Decider } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	defineTask,
	type JsonObject,
	openHarness,
	publishExtension,
	TelemetryReader,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { ChecksDocument } from "../src/checks.ts";
import { DecisionDocument, decisionExtension } from "../src/decisions.ts";
import { PublisherDocument } from "../src/publish.ts";
import * as staticRunner from "../src/static.ts";
import { TimingDocument } from "../src/task-timing.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

const previous = JSON.parse(
	readFileSync(new URL("./fixtures/stage-telemetry-previous/tasks.json", import.meta.url), "utf8"),
) as {
	tasks: Record<
		string,
		{ kind: string; version: number; input: JsonObject; state: { checkpoint: { phase: string } & JsonObject } }
	>;
};
let repo: string;
let close: () => Promise<void>;
afterEach(async () => {
	await close?.();
	vi.restoreAllMocks();
	rmSync(repo, { recursive: true, force: true });
});

it.each([
	["melian.check", "retired", "aborted"],
	["melian.check", "lost-authority", "aborted"],
	["melian.decision", "wrong-decider", "aborted"],
	["melian.decision", "superseded", "completed"],
	["melian.decision", "failure", "completed"],
	["melian.adjudication", "superseded", "completed"],
	["melian.publish", "failure", "failed"],
	["melian.publish", "superseded", "completed"],
	["melian.check", "abort", "aborted"],
	["melian.decision", "abort", "aborted"],
	["melian.adjudication", "abort", "aborted"],
	["melian.publish", "abort", "aborted"],
])("records the terminal end for %s on %s", async (kind, mode, status) => {
	repo = crashRepository();
	const changeset = await Changeset.resolve(repo, "main...feature");
	const sample = previous.tasks["melian.check"]!.input.changeset as {
		repoRoot: string;
		revision: { base: string; head: string };
	};
	const recorded = previous.tasks[kind]!;
	const input = JSON.parse(
		JSON.stringify(recorded.input)
			.replaceAll(sample.repoRoot, repo)
			.replaceAll(sample.revision.base, changeset.revision.base)
			.replaceAll(sample.revision.head, changeset.revision.head),
	) as JsonObject;
	if (kind === "melian.adjudication") {
		delete input.policy;
		delete input.resolutionPolicy;
	}
	const fake = createFakeModels();
	const storage = createMemoryStorage();
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	const decider: Decider = {
		name: mode === "wrong-decider" ? "other-decider" : "telemetry-test",
		calibrated: true,
		decide: async (request) => {
			expect(request.questions.map(({ id }) => id)).toEqual(["correctness"]);
			if (mode === "failure") throw new Error("decider failed");
			return { answers: [{ question: "correctness", distribution: { quick: 1 } }] };
		},
	};
	registry.install(decisionExtension(decider));
	const state = pullRequestState();
	registry.install(
		publishExtension(
			createGitHubProvider({ owner: state.owner, repo: state.repo, token: "test-token", fetch: fakeGitHub(state) }),
		),
	);
	const harness = await openHarness(storage, {
		models: fake.models,
		registry,
		env: () => createNodeExecutionEnv(repo),
	});
	close = () => harness.close(context);
	const root = await harness.root(context);
	const revision = `${changeset.revision.base}..${changeset.revision.head}`;
	vi.spyOn(staticRunner, "runStaticTool").mockImplementation(async (request) => {
		expect(mode).toBe("lost-authority");
		expect(request.tool).toBe("mutation");
		await root.commit(async (tx) => {
			(await tx.doc(ChecksDocument, root.id)).owners = { [revision]: "other" };
		}, context);
		return {
			status: "ran",
			log: { version: "2.1.0", runs: [{ tool: { driver: { name: "mutation", version: "test" } }, results: [] }] },
			notes: [],
		};
	});
	const token = defineTask<JsonObject, { phase: string }, null>({
		name: kind,
		version: { "melian.check": 3, "melian.decision": 2, "melian.adjudication": 4, "melian.publish": 5 }[kind]!,
		initial: () => ({ phase: recorded.state.checkpoint.phase }),
		phases: {
			run: async () => {
				throw new Error("token must not run");
			},
		},
		abort: async () => {
			throw new Error("token must not abort");
		},
	});
	const id = await root.commit(async (tx) => {
		const id = await tx.createTask(token, input, { ownership: { kind: "conversation" } });
		if (mode === "retired") (await tx.doc(ChecksDocument, root.id)).owners = { [revision]: "other" };
		if (kind === "melian.decision" && mode === "failure")
			(await tx.doc(DecisionDocument, root.id)).decisions[revision] = {
				triage: { task: id, key: input.key as string },
			};
		if (kind === "melian.publish" && mode !== "superseded")
			Object.assign(await tx.doc(PublisherDocument, root.id), {
				target: input.target,
				publishedBy: input.publishedBy,
			});
		return id;
	}, context);
	if (mode === "abort") await harness.abortTask(id, context);
	const settled = await harness.waitForTask(id, context);
	expect(settled.state.outcome.status).toBe(status);
	if (mode === "superseded" && kind !== "melian.publish" && settled.state.outcome.status === "completed")
		expect(settled.state.outcome.result).toBe("superseded");
	const timing = await storage.findDocument(
		{
			kind: TimingDocument.definition.kind,
			scope: { kind: "conversation", conversationId: root.id },
			key: String(id),
		},
		"current",
		context,
	);
	const value = (await storage.document(timing!.id, "current", context))!.value;
	expect(value.endedAt).toEqual(expect.any(Number));
	if (mode === "abort") expect(value.startedAt).toBeUndefined();
	else expect(value.startedAt).toEqual(expect.any(Number));
	if (kind === "melian.publish") {
		const telemetry = await TelemetryReader.open(storage).read(revision);
		expect(telemetry.stages[0]!.outcome).toBe(mode === "superseded" ? "superseded" : status);
	}
	expect(fake.provider.state.callCount).toBe(0);
});
