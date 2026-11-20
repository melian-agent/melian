import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checksExtension,
	backgroundContext as context,
	createNodeExecutionEnv,
	createRegistry,
	defineDoc,
	defineTask,
	type Harness,
	type JsonObject,
	openHarness,
	openSqliteStorage,
	type Storage,
	type TaskId,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChecksDocument } from "../src/checks.ts";
import { FindingsDocument, stampOf } from "../src/findings.ts";
import { StaticProof } from "../src/static-proof.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Legacy = { [key: string]: Json };
type RecordedTask = { kind: string; version: number; input: JsonObject };
const recorded = JSON.parse(readFileSync(new URL("./fixtures/stored-checks-v4/run.json", import.meta.url), "utf8")) as {
	repoRoot: string;
	revision: { base: string; head: string };
	key: string;
	request: string;
	tasks: RecordedTask[];
	checks: Legacy;
	findings: Legacy;
};
const legacy = (kind: string, version: number) =>
	defineDoc<Legacy>({
		kind,
		version,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({}),
	});
const task = (kind: string) => recorded.tasks.find((each) => each.kind === kind)!;

let dir: string;
let opened: Harness[];
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-check-stamp-reopen-")));
	opened = [];
});
afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

async function open(storage: Storage, options: { checks?: true; repo?: string } = {}) {
	const fake = createFakeModels();
	const registry = createRegistry();
	if (options.checks) registry.install(checksExtension);
	const harness = await openHarness(storage, {
		models: fake.models,
		registry,
		...(options.repo === undefined ? {} : { env: () => createNodeExecutionEnv(options.repo!) }),
	});
	opened.push(harness);
	return { harness, root: await harness.root(context, { agent: { model: fake.ref() } }) };
}

it("reads what version-4 checks and version-11 findings wrote after an SQLite reopen, and proves no run by them", async () => {
	const path = join(dir, "reopen.sqlite");
	const first = await open(await openSqliteStorage(path));
	await first.root.commit(async (tx) => {
		Object.assign(await tx.doc(legacy("melian.checks", 4), first.root.id), recorded.checks);
		Object.assign(await tx.doc(legacy("melian.findings", 11), first.root.id), recorded.findings);
	}, context);
	await first.harness.close(context);
	opened = [];

	const second = await open(await openSqliteStorage(path));
	expect(await second.harness.snapshot(ChecksDocument, second.root.id, context)).toEqual(recorded.checks);
	const findings = await second.harness.snapshot(FindingsDocument, second.root.id, context);
	expect(findings).toEqual(recorded.findings);
	expect(stampOf(findings, recorded.key, "static.biome")).toBeUndefined();
	const proof = await StaticProof.read(second.harness, second.root.id, context);
	expect(proof.proves(findings, recorded.key, "static.biome", recorded.request)).toBe(false);
	expect(proof.asks("static.biome", recorded.request)).toBe(false);

	await second.root.commit(async (tx) => {
		(await tx.doc(ChecksDocument, second.root.id)).requests = { [recorded.request]: {} };
		(await tx.doc(FindingsDocument, second.root.id)).checkRuns = {
			[recorded.key]: { "static.biome": { request: "x", task: 1 } },
		};
	}, context);
	await expect(second.harness.snapshot(legacy("melian.checks", 4), second.root.id, context)).rejects.toThrow(
		/newer version 5 than 4/,
	);
	await expect(second.harness.snapshot(legacy("melian.findings", 11), second.root.id, context)).rejects.toThrow(
		/newer version 12 than 11/,
	);
});

describe("a check task main stored before its input carried the run's key", { timeout: 120_000 }, () => {
	let repo: string;
	let base: string;
	let head: string;
	beforeEach(() => {
		repo = createRepository();
		base = commit(repo, {
			"melian.yaml": lines("tiers:", "  fast: [static.biome]"),
			"src/a.ts": "export const a = 1;\n",
		});
		head = commit(repo, { "src/a.ts": "debugger;\nexport const a = 2;\n" });
	});
	afterEach(() => removeRepository(repo));

	const remapped = (input: JsonObject) =>
		JSON.parse(
			JSON.stringify(input)
				.replaceAll(recorded.repoRoot, repo)
				.replaceAll(recorded.revision.base, base)
				.replaceAll(recorded.revision.head, head),
		) as JsonObject;

	// Creates a task of main's version from its recorded input, closes SQLite, and resumes it under today's checks.
	async function resume(kind: "melian.check" | "melian.checks", phase: "run" | "start") {
		const old = task(kind);
		const input = remapped(old.input);
		expect(input).not.toHaveProperty("request");
		const path = join(dir, `${kind}.sqlite`);
		const first = await open(await openSqliteStorage(path));
		const token = defineTask<JsonObject, { phase: string }, JsonObject>({
			name: kind,
			version: old.version,
			initial: () => ({ phase }),
			phases: {
				[phase]: async () => {
					throw new Error("old task must not execute");
				},
			},
			abort: async () => {
				throw new Error("old task must not abort");
			},
		});
		const id = await first.root.commit(
			(tx) => tx.createTask(token, input, { ownership: { kind: "conversation" } }),
			context,
		);
		await first.harness.close(context);
		opened = [];
		const second = await open(await openSqliteStorage(path), { checks: true, repo });
		const done = await second.harness.waitForTask(id as TaskId, context);
		const findings = await second.harness.snapshot(FindingsDocument, second.root.id, context);
		return { second, done, findings, version: (await second.harness.getTask(id as TaskId, context))?.version };
	}

	it("runs its check under today's version, and leaves its sightings without a stamp", async () => {
		expect(task("melian.check").version).toBe(4);
		const { done, findings, version } = await resume("melian.check", "run");

		expect(done.state.outcome).toMatchObject({
			status: "completed",
			result: { name: "static.biome", status: "ran" },
		});
		expect(version).toBe(5);
		expect(Object.keys(findings?.items ?? {})).toHaveLength(1);
		expect(stampOf(findings, `${base}..${head}`, "static.biome")).toBeUndefined();
	});

	it("runs a tier under today's version, whose checks leave their sightings without a stamp", async () => {
		expect(task("melian.checks").version).toBe(3);
		const { done, findings, version } = await resume("melian.checks", "start");

		expect(done.state.outcome).toMatchObject({
			status: "completed",
			result: [{ name: "static.biome", status: "ran" }],
		});
		expect(version).toBe(4);
		expect(Object.keys(findings?.items ?? {})).toHaveLength(1);
		expect(findings?.checkRuns).toBeUndefined();
	});
});
