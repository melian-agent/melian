import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset } from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createRegistry,
	defineTask,
	type Harness,
	type JsonObject,
	openHarness,
	openSqliteStorage,
	readFindings,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { ChecksDocument } from "../src/checks.ts";
import { TimingDocument } from "../src/task-timing.ts";
import { baseAndHead, isolatedGitEnv } from "./fixtures/repo.ts";

const previous = JSON.parse(
	readFileSync(new URL("./fixtures/migrations-from-version/check-v1.json", import.meta.url), "utf8"),
) as {
	task: {
		kind: string;
		version: number;
		input: JsonObject & {
			run: string;
			changeset: { repoRoot: string; revision: { base: string; head: string } };
		};
		state: { checkpoint: { phase: "run" } };
	};
};
const directories: string[] = [];
const opened: Harness[] = [];
afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

it("reopens a version-1 check with its input intact and no invented timing start", async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	const policy =
		"tiers:\n  fast: [guardrails]\nguardrails:\n  forbidden-patterns:\n    rules:\n      todo: { pattern: TODO, message: Finish the TODO }\n";
	const repo = baseAndHead({ "melian.yaml": policy, "notes.txt": "ready\n" }, { "notes.txt": "TODO\n" });
	directories.push(repo);
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-check-task-reopen-")));
	directories.push(directory);
	const path = join(directory, "state.sqlite");
	const changeset = await Changeset.resolve(repo, "main...feature");
	const sample = previous.task.input.changeset;
	const input = JSON.parse(
		JSON.stringify(previous.task.input)
			.replaceAll(sample.repoRoot, repo)
			.replaceAll(sample.revision.base, changeset.revision.base)
			.replaceAll(sample.revision.head, changeset.revision.head),
	) as typeof previous.task.input;
	const fake = createFakeModels();
	const first = await openHarness(await openSqliteStorage(path), { models: fake.models, registry: createRegistry() });
	opened.push(first);
	const root = await first.root(context);
	expect(previous.task.version).toBe(1);
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
	const id = await root.commit((tx) => tx.createTask(token, input, { ownership: { kind: "conversation" } }), context);
	await first.close(context);
	const registry = createRegistry();
	registry.install(checksExtension);
	const storage = await openSqliteStorage(path);
	const second = await openHarness(storage, { models: fake.models, registry });
	opened.push(second);
	expect((await second.waitForTask(id, context)).state.outcome).toEqual({
		status: "completed",
		result: { name: "guardrails", status: "ran", findings: 1, notes: [] },
	});
	const task = (await storage.task(id, context))!;
	expect(task.version).toBe(3);
	expect(task.input).toEqual(input);
	expect((await second.snapshot(ChecksDocument, root.id, context))!.runs[input.run]).toEqual({
		guardrails: { name: "guardrails", status: "ran", findings: 1, notes: [] },
	});
	const findings = await readFindings(second, root.id, revisionKey(changeset.revision), context);
	expect(findings).toHaveLength(1);
	expect(findings[0]!.ruleId).toBe("guardrail/forbidden-patterns");
	const timing = await second.snapshot(TimingDocument, root.id, String(id), context);
	expect(timing).toEqual({ legacy: true, endedAt: expect.any(Number) });
	expect(fake.provider.state.callCount).toBe(0);
});
