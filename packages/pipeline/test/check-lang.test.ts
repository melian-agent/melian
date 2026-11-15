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
	defineTask,
	type ExecutionEnv,
	type Harness,
	type JsonObject,
	openHarness,
	openSqliteStorage,
	runChecks,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let repo: string;
let base: string;
let head: string;
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
	});
});
