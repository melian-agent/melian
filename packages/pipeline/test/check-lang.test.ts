import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, loadConfig, type RepositorySource } from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createRegistry,
	createReviewRegistry,
	defineExtension,
	defineTask,
	type ExecutionEnv,
	type Harness,
	type JsonObject,
	openHarness,
	openSqliteStorage,
	runChecks,
	type TaskId,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimingDocument } from "../src/task-timing.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

const previous = JSON.parse(
	readFileSync(new URL("./fixtures/migrations-from-version/check-v3.json", import.meta.url), "utf8"),
) as {
	task: {
		kind: string;
		version: number;
		input: JsonObject & { changeset: { repoRoot: string; revision: { base: string; head: string } } };
		state: { checkpoint: { phase: "run" } };
	};
};

const mainChecks = JSON.parse(
	readFileSync(new URL("./fixtures/migrations-from-version/checks-v2.json", import.meta.url), "utf8"),
) as {
	task: {
		kind: string;
		version: number;
		input: JsonObject & { changeset: { repoRoot: string; revision: { base: string; head: string } } };
	};
};

let repo: string;
let base: string;
let head: string;
type Token = ReturnType<typeof defineTask<JsonObject, { phase: string }, JsonObject>>;
const opened: Harness[] = [];
const directories: string[] = [];

beforeEach(() => {
	repo = createRepository();
	base = commit(repo, {
		"melian.yaml": lines("tiers:", "  fast: [static.biome]"),
		"src/a.ts": "export const a = 1;\n",
	});
	head = commit(repo, { "src/a.ts": "export const a = 2;\n" });
});

afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
	removeRepository(repo);
});

// Records the `LANG` each command is given, and moves the process to `later` once a tool runs, as a resume in a shell with
// another locale would.
function recording(later: string | undefined): { env: ExecutionEnv; seen: (string | undefined)[] } {
	const node = createNodeExecutionEnv(repo);
	const env: ExecutionEnv = Object.create(node);
	const seen: (string | undefined)[] = [];
	env.exec = (command, options, given) => {
		vi.stubEnv("LANG", later);
		seen.push(options?.env?.LANG);
		return node.exec(command, options, given);
	};
	return { env, seen };
}

describe("the LANG a check's tools run with", { timeout: 120_000 }, () => {
	it("is the one the run's key read, whatever the process holds by the time the tools run", async () => {
		vi.stubEnv("LANG", "en_AU.UTF-8");
		const { env, seen } = recording("C.UTF-8");
		const fake = createFakeModels();
		const registry = createReviewRegistry();
		registry.install(checksExtension);
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry, env: () => env });
		opened.push(harness);
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const source: RepositorySource = { kind: "revision", commit: base };
		const { config } = await loadConfig(repo, source, "");
		const run = await runChecks(
			harness,
			{ rootConversationId: root.id, changeset, config, source, tier: "fast" },
			context,
		);
		expect(run.records).toMatchObject([{ name: "static.biome", status: "ran" }]);
		expect(seen.length).toBeGreaterThan(1);
		expect(new Set(seen)).toEqual(new Set(["en_AU.UTF-8"]));
	});

	it("is none when the key read none, though the process has one by then", async () => {
		vi.stubEnv("LANG", undefined);
		const { env, seen } = recording("C.UTF-8");
		const fake = createFakeModels();
		const registry = createReviewRegistry();
		registry.install(checksExtension);
		const harness = await openHarness(createMemoryStorage(), { models: fake.models, registry, env: () => env });
		opened.push(harness);
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const source: RepositorySource = { kind: "revision", commit: base };
		const { config } = await loadConfig(repo, source, "");
		const run = await runChecks(
			harness,
			{ rootConversationId: root.id, changeset, config, source, tier: "fast" },
			context,
		);
		expect(run.records).toMatchObject([{ name: "static.biome", status: "ran" }]);
		expect(seen.length).toBeGreaterThan(1);
		expect(new Set(seen)).toEqual(new Set([undefined]));
	});

	it("is the process's for a check main stored before its input carried one", async () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-check-lang-")));
		directories.push(directory);
		const path = join(directory, "state.sqlite");
		const sample = previous.task.input.changeset;
		const input = JSON.parse(
			JSON.stringify(previous.task.input)
				.replaceAll(sample.repoRoot, repo)
				.replaceAll(sample.revision.base, base)
				.replaceAll(sample.revision.head, head),
		) as typeof previous.task.input;
		expect(previous.task.version).toBe(3);
		expect(input).not.toHaveProperty("lang");
		const fake = createFakeModels();
		const first = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createRegistry(),
		});
		opened.push(first);
		const root = await first.root(context);
		const token = defineTask<JsonObject, { phase: "run" }, JsonObject>({
			name: previous.task.kind,
			version: previous.task.version,
			initial: () => previous.task.state.checkpoint,
			phases: {
				run: async () => {
					throw new Error("old task must not execute");
				},
			},
			abort: async () => {
				throw new Error("old task must not abort");
			},
		});
		const id = await root.commit(
			(tx) => tx.createTask(token, input, { ownership: { kind: "conversation" } }),
			context,
		);
		await first.close(context);
		vi.stubEnv("LANG", "C.UTF-8");
		const { env, seen } = recording("C.UTF-8");
		const registry = createRegistry();
		registry.install(checksExtension);
		const second = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry,
			env: () => env,
		});
		opened.push(second);
		expect((await second.waitForTask(id, context)).state.outcome).toMatchObject({
			status: "completed",
			result: { name: "static.biome", status: "ran" },
		});
		expect(seen.length).toBeGreaterThan(1);
		expect(new Set(seen)).toEqual(new Set(["C.UTF-8"]));
		expect((await second.getTask(id, context))?.version).toBe(4);
		expect(await second.snapshot(TimingDocument, root.id, String(id), context)).toEqual({
			startedAt: expect.any(Number),
			endedAt: expect.any(Number),
		});
	});

	it("is the process's for a tier main stored before its input carried one", async () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-check-lang-")));
		directories.push(directory);
		const path = join(directory, "state.sqlite");
		const sample = mainChecks.task.input.changeset;
		const input = JSON.parse(
			JSON.stringify(mainChecks.task.input)
				.replaceAll(sample.repoRoot, repo)
				.replaceAll(sample.revision.base, base)
				.replaceAll(sample.revision.head, head),
		) as JsonObject;
		expect(mainChecks.task.version).toBe(2);
		expect(input).not.toHaveProperty("lang");
		const fake = createFakeModels();
		const first = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createRegistry(),
		});
		opened.push(first);
		const root = await first.root(context);
		const token = defineTask<JsonObject, { phase: "start" }, JsonObject>({
			name: mainChecks.task.kind,
			version: mainChecks.task.version,
			initial: () => ({ phase: "start" }),
			phases: {
				start: async () => {
					throw new Error("old task must not execute");
				},
			},
			abort: async () => {
				throw new Error("old task must not abort");
			},
		});
		const id = await root.commit(
			(tx) => tx.createTask(token, input, { ownership: { kind: "conversation" } }),
			context,
		);
		await first.close(context);
		vi.stubEnv("LANG", "C.UTF-8");
		const { env, seen } = recording("C.UTF-8");
		const registry = createRegistry();
		registry.install(checksExtension);
		const second = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry,
			env: () => env,
		});
		opened.push(second);
		expect((await second.waitForTask(id, context)).state.outcome).toMatchObject({
			status: "completed",
			result: [{ name: "static.biome", status: "ran" }],
		});
		expect((await second.getTask(id, context))?.version).toBe(3);
		expect(seen.length).toBeGreaterThan(1);
		expect(new Set(seen)).toEqual(new Set(["C.UTF-8"]));
	});

	it("leaves a tier from before version 2 refused, as it was", () => {
		const registry = createRegistry();
		registry.install(checksExtension);
		const { definition } = registry.snapshot().task("melian.checks") as Token;
		const input = mainChecks.task.input;
		expect(definition.migrate?.(input, { phase: "start" }, 2)).toEqual({ input, checkpoint: { phase: "start" } });
		expect(() => definition.migrate?.(input, { phase: "start" }, 1)).toThrow(
			"melian.checks cannot resume a version-1 task",
		);
	});

	// A build before the input carried `lang` would run these tasks under the process's locale and record the result under
	// the key that read another.
	it("is never left to a build that ignores it, for either task this build stores", async () => {
		vi.stubEnv("LANG", "en_AU.UTF-8");
		const fake = createFakeModels();
		const registry = createReviewRegistry();
		registry.install(checksExtension);
		const recorder = await openHarness(createMemoryStorage(), {
			models: fake.models,
			registry,
			env: () => recording("en_AU.UTF-8").env,
		});
		opened.push(recorder);
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const source: RepositorySource = { kind: "revision", commit: base };
		const { config } = await loadConfig(repo, source, "");
		const root = await recorder.root(context, { agent: { model: fake.ref() } });
		const run = await runChecks(
			recorder,
			{ rootConversationId: root.id, changeset, config, source, tier: "fast" },
			context,
		);
		const stored = await recorder.getTask(run.identity.task as TaskId, context);
		expect(stored?.input).toMatchObject({ lang: "en_AU.UTF-8" });

		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-check-lang-")));
		directories.push(directory);
		const path = join(directory, "state.sqlite");
		const sample = previous.task.input.changeset;
		const check = {
			...(JSON.parse(
				JSON.stringify(previous.task.input)
					.replaceAll(sample.repoRoot, repo)
					.replaceAll(sample.revision.base, base)
					.replaceAll(sample.revision.head, head),
			) as JsonObject),
			lang: "en_AU.UTF-8",
		};
		const today = registry.snapshot();
		const first = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createRegistry(),
		});
		opened.push(first);
		const owner = await first.root(context);
		const ids = await owner.commit(
			async (tx) => [
				await tx.createTask(today.task("melian.checks") as Token, stored?.input as JsonObject, {
					ownership: { kind: "conversation" },
				}),
				await tx.createTask(today.task("melian.check") as Token, check, { ownership: { kind: "conversation" } }),
			],
			context,
		);
		await first.close(context);
		const ran: string[] = [];
		const older = (name: string, version: number) =>
			defineTask<JsonObject, { phase: string }, JsonObject>({
				name,
				version,
				initial: () => ({ phase: name === "melian.checks" ? "start" : "run" }),
				phases: {
					[name === "melian.checks" ? "start" : "run"]: async () => {
						ran.push(name);
						throw new Error("an older build must not run this task");
					},
				},
				abort: async () => {
					throw new Error("an older build must not abort this task");
				},
			});
		const before = createRegistry();
		before.install(
			defineExtension({ name: "melian.checks", tasks: [older("melian.checks", 2), older("melian.check", 3)] }),
		);
		const second = await openHarness(await openSqliteStorage(path), { models: fake.models, registry: before });
		opened.push(second);
		const states = (await second.inspect(context)).tasks
			.filter((each) => (ids as TaskId[]).includes(each.record.id as TaskId))
			.map((each) => [each.record.kind, each.state]);
		expect(states).toEqual([
			["melian.checks", { kind: "blocked", reason: "task_too_old" }],
			["melian.check", { kind: "blocked", reason: "task_too_old" }],
		]);
		expect(ran).toEqual([]);
	});
});
