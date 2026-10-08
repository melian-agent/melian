import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Changeset, loadConfig, mutationSkips, type RepositorySource } from "@melian-agent/core";
import {
	checksExtension,
	backgroundContext as context,
	createNodeExecutionEnv,
	createReviewRegistry,
	defineTask,
	type Harness,
	openHarness,
	openSqliteStorage,
	readFindings,
	revisionKey,
	runChecks,
	type TaskId,
	type WriterTrust,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChecksDocument, MutationProcesses } from "../src/checks.ts";
import { type ProcessEntry, ProcessTable } from "../src/mutation-process.ts";
import { Sandbox } from "../src/sandbox.ts";
import { fakeMutationProcesses } from "./fixtures/mutation-process.ts";
import { commit, createRepository, fakeTool, lines, removeRepository } from "./fixtures/repo.ts";
import { unconfinedSandbox } from "./fixtures/sandbox.ts";

let repo: string;
let artifacts: string;
let opened: Harness[];

beforeEach(() => {
	fakeMutationProcesses();
	vi.spyOn(Sandbox, "detect").mockReturnValue(unconfinedSandbox);
	repo = createRepository();
	artifacts = realpathSync(mkdtempSync(join(tmpdir(), "melian-authority-")));
	opened = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(opened.map((harness) => harness.close(context)));
	removeRepository(repo);
	rmSync(artifacts, { recursive: true, force: true });
});

const trusted: WriterTrust = { trusted: true };
const revoked: WriterTrust = { trusted: false, detail: "write permission was revoked" };
const source = (commitId: string): RepositorySource => ({ kind: "revision", commit: commitId });
const a = lines("export function a(x: number) {", "  if (x > 0) return 1;", "  return 0;", "}");
const survivor = JSON.stringify({
	schemaVersion: "1.0",
	files: {
		"packages/p/src/a.ts": {
			language: "typescript",
			source: "",
			mutants: [
				{
					id: "0",
					mutatorName: "ConditionalExpression",
					replacement: "true",
					status: "Survived",
					location: { start: { line: 2, column: 3 }, end: { line: 2, column: 9 } },
				},
			],
		},
	},
});

// A change with one survivor, and a fake Stryker that counts its runs, waits for `release` when asked to, and reports it.
function scenario(gated = false) {
	const base = commit(repo, {
		".gitignore": "node_modules\n",
		"melian.yaml": lines(
			"tiers:",
			"  full: [static.mutation]",
			"static:",
			"  mutation: { enabled: true, timeout: 120 }",
		),
		"stryker.config.json": JSON.stringify({ testRunner: "vitest" }),
		"packages/p/src/a.ts": a,
	});
	const head = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x >= 0") });
	writeFileSync(join(artifacts, "report.json"), survivor);
	fakeTool(
		repo,
		"stryker",
		`if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
echo run >> '${join(artifacts, "runs.txt")}'
${gated ? `while [ ! -e '${join(artifacts, "release")}' ]; do sleep 0.1; done` : ""}
mkdir -p reports/mutation
cp '${join(artifacts, "report.json")}' reports/mutation/mutation.json`,
	);
	return { base, head };
}

const runs = () =>
	existsSync(join(artifacts, "runs.txt"))
		? readFileSync(join(artifacts, "runs.txt"), "utf8").trim().split("\n").length
		: 0;

async function openOn(database: string, environment = true) {
	const fake = createFakeModels();
	const registry = createReviewRegistry();
	registry.install(checksExtension);
	const harness = await openHarness(await openSqliteStorage(database), {
		models: fake.models,
		registry,
		env: () => (environment ? createNodeExecutionEnv(repo) : undefined),
	});
	opened.push(harness);
	return { harness, root: await harness.root(context, { agent: { model: fake.ref() } }) };
}

// A process table that holds only what a test puts in it, and signals nothing: a kill removes the entry.
function fakeProcesses(entries: ProcessEntry[]) {
	const kills: [number, string][] = [];
	vi.spyOn(ProcessTable.prototype, "list").mockImplementation(() => entries.map((entry) => ({ ...entry })));
	vi.spyOn(ProcessTable.prototype, "kill").mockImplementation((pid, signal) => {
		kills.push([pid, signal]);
		const at = entries.findIndex((entry) => entry.pid === pid);
		if (at !== -1) entries.splice(at, 1);
	});
	return kills;
}

async function input(
	base: string,
	head: string,
	rootConversationId: Parameters<typeof runChecks>[1]["rootConversationId"],
	writer: WriterTrust,
) {
	const { config } = await loadConfig(repo, source(base), "");
	return {
		rootConversationId,
		changeset: await Changeset.resolve(repo, `${base}..${head}`),
		config,
		source: source(base),
		tier: "full",
		writer,
	};
}

// Runs the check for a trusted writer in a process of its own, kills it inside Stryker, and returns the database it left.
async function crashed(base: string, head: string): Promise<string> {
	const database = join(artifacts, "state.sqlite");
	const log = join(artifacts, "parked.log");
	const child = spawn(
		process.execPath,
		[
			"--conditions=@melian-agent/source",
			fileURLToPath(new URL("./fixtures/checks-crash.ts", import.meta.url)),
			repo,
			base,
			head,
			database,
			log,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal ?? code)));
	const deadline = Date.now() + 30_000;
	try {
		while (!existsSync(log)) {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error(`exited early:\n${stderr}`);
			if (Date.now() > deadline) throw new Error(`never reached Stryker:\n${stderr}`);
			await sleep(20);
		}
	} finally {
		child.kill("SIGKILL");
	}
	expect(await exited).toBe("SIGKILL");
	return database;
}

// The live check tasks the harness holds; inspect lists no task that has ended.
async function liveChecks(harness: Harness) {
	return (await harness.inspect(context)).tasks.filter((each) => each.record.kind === "melian.check");
}

async function outcomeOf(harness: Harness, id: TaskId) {
	return (await harness.waitForTask(id, context)).state.outcome;
}

describe("the authority over a revision's mutation check", { timeout: 120_000 }, () => {
	it("runs again when the host changes between available sandbox backends", async () => {
		const { base, head } = scenario();
		const { harness, root } = await openOn(join(artifacts, "state.sqlite"));
		const wait = harness.waitForTask.bind(harness);
		vi.spyOn(harness, "waitForTask").mockImplementation((id, executionContext) => {
			expect(id).toBeTypeOf("number");
			return wait(id, executionContext);
		});
		const request = await input(base, head, root.id, trusted);
		const first = await runChecks(harness, request, context);
		vi.mocked(Sandbox.detect).mockReturnValue({ ...unconfinedSandbox, backend: "bubblewrap" } as Sandbox);
		const second = await runChecks(harness, request, context);
		expect(second.identity.policy).not.toBe(first.identity.policy);
		expect(second.identity.task).not.toBe(first.identity.task);
		expect(runs()).toBe(2);
	});

	it("leaves a running mutation check of another revision alone", async () => {
		const { base, head } = scenario(true);
		const otherHead = commit(repo, { "packages/p/src/a.ts": a.replace("x > 0", "x <= 0") });
		const { harness, root } = await openOn(join(artifacts, "state.sqlite"));
		const first = runChecks(harness, await input(base, head, root.id, trusted), context);
		const deadline = Date.now() + 20_000;
		while (runs() === 0) {
			if (Date.now() > deadline) throw new Error("Stryker never started");
			await sleep(20);
		}
		try {
			const second = await runChecks(harness, await input(base, otherHead, root.id, revoked), context);
			expect(second.records).toMatchObject([{ status: "skipped", cause: "untrustedWriter" }]);
		} finally {
			writeFileSync(join(artifacts, "release"), "");
		}
		expect((await first).records).toMatchObject([{ name: "static.mutation", status: "ran" }]);
		expect(runs()).toBe(1);
	});

	it("leaves a task of another kind alone even when its input resembles a retired mutation check", async () => {
		const { base, head } = scenario();
		const { harness, root } = await openOn(join(artifacts, "state.sqlite"));
		const request = await input(base, head, root.id, revoked);
		const other = defineTask<unknown, { phase: "park" }, unknown>({
			name: "uninstalled.other",
			version: 1,
			initial: () => ({ phase: "park" }),
			phases: { park: async () => {} },
			abort: async (_task, runtime, executionContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), executionContext);
			},
		});
		const id = await root.commit(
			(tx) =>
				tx.createTask(
					other,
					{ check: "static.mutation", changeset: request.changeset.toJSON(), authority: "retired" },
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		const abort = vi.spyOn(harness, "abortTask");
		await runChecks(harness, request, context);
		expect(abort.mock.calls.map(([task]) => task)).not.toContain(id);
	});

	it("leaves another check kind running when mutation authority changes", async () => {
		const { base, head } = scenario(true);
		fakeTool(
			repo,
			"biome",
			`if [ "$1" = "--version" ]; then echo 2.5.15; exit 0; fi
echo started > '${join(artifacts, "biome-started")}'
while [ ! -e '${join(artifacts, "release")}' ]; do sleep 0.1; done
for flag in "$@"; do case "$flag" in --reporter-file=*) file="\${flag#--reporter-file=}";; esac; done
echo '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"Biome","version":"2.5.15"}},"results":[]}]}' > "$file"`,
		);
		const { harness, root } = await openOn(join(artifacts, "state.sqlite"));
		const request = await input(base, head, root.id, trusted);
		const first = runChecks(
			harness,
			{
				...request,
				config: {
					...request.config,
					tiers: { ...request.config.tiers, full: ["static.biome", "static.mutation"] },
				},
			},
			context,
		);
		const deadline = Date.now() + 20_000;
		while (!existsSync(join(artifacts, "biome-started")) || runs() === 0) {
			if (Date.now() > deadline) throw new Error("checks never started");
			await sleep(20);
		}
		try {
			await runChecks(harness, await input(base, head, root.id, revoked), context);
		} finally {
			writeFileSync(join(artifacts, "release"), "");
		}
		expect((await first).records).toMatchObject([
			{ name: "static.biome", status: "ran" },
			{ name: "static.mutation", status: "failed", reason: "aborted" },
		]);
	});

	it("is not run again by a task a crash left pending when the next review revokes trust, and the task writes nothing", async () => {
		const { base, head } = scenario();
		const database = await crashed(base, head);
		expect(runs()).toBe(0);
		const { harness, root } = await openOn(database);
		const [pending] = await liveChecks(harness);
		const run = await runChecks(harness, await input(base, head, root.id, revoked), context);
		expect(run.records).toEqual([
			{
				name: "static.mutation",
				status: "skipped",
				reason: mutationSkips.untrustedWriter(revoked.detail),
				cause: "untrustedWriter",
			},
		]);
		expect(await readFindings(harness, root.id, revisionKey({ base, head }), context)).toEqual([]);
		expect(await liveChecks(harness)).toEqual([]);
		expect(await outcomeOf(harness, pending!.record.id)).toEqual({ status: "aborted" });
		expect(runs()).toBe(0);
	});

	it("records the tree while head code runs and clears it after termination", async () => {
		const { base, head } = scenario(true);
		const { harness, root } = await openOn(join(artifacts, "state.sqlite"));
		const run = runChecks(harness, await input(base, head, root.id, trusted), context);
		const deadline = Date.now() + 20_000;
		while (runs() === 0) {
			if (Date.now() > deadline) throw new Error("Stryker never started");
			await sleep(20);
		}
		try {
			const trees = Object.values((await harness.snapshot(MutationProcesses, root.id, context))!.trees);
			expect(trees).toHaveLength(1);
			expect(trees[0]!.root.pid).toBe(3);
		} finally {
			writeFileSync(join(artifacts, "release"), "");
			await run;
		}
		expect((await harness.snapshot(MutationProcesses, root.id, context))!.trees).toEqual({});
	});

	const recordTree = async (root: Awaited<ReturnType<typeof openOn>>["root"], task: number) => {
		await root.commit(async (tx) => {
			(await tx.doc(MutationProcesses, root.id)).trees[String(task)] = {
				control: join(artifacts, "gone-control"),
				supervisor: { pid: 4242, start: "Thu Oct 8 10:00:00 2026" },
				root: { pid: 4243, start: "Thu Oct 8 10:00:01 2026" },
			};
		}, context);
	};
	const alive: ProcessEntry[] = [
		{ pid: 4242, ppid: 1, start: "Thu Oct 8 10:00:00 2026" },
		{ pid: 4243, ppid: 4242, start: "Thu Oct 8 10:00:01 2026" },
	];

	it("ends the recorded processes by pid before replaying the trusted task", async () => {
		const { base, head } = scenario();
		const database = await crashed(base, head);
		const { harness, root } = await openOn(database);
		const [pending] = await liveChecks(harness);
		await recordTree(root, pending!.record.id);
		const kills = fakeProcesses(alive.map((entry) => ({ ...entry })));
		await runChecks(harness, await input(base, head, root.id, trusted), context);
		expect(kills).toEqual([
			[4242, "SIGTERM"],
			[4243, "SIGTERM"],
		]);
	});

	it("leaves a pid alone whose start time differs from the recorded one", async () => {
		const { base, head } = scenario();
		const database = await crashed(base, head);
		const { harness, root } = await openOn(database);
		const [pending] = await liveChecks(harness);
		await recordTree(root, pending!.record.id);
		const kills = fakeProcesses(alive.map((entry) => ({ ...entry, start: "Fri Oct 9 09:00:00 2026" })));
		await runChecks(harness, await input(base, head, root.id, trusted), context);
		expect(kills).toEqual([]);
	});

	it("refuses recovery with a recorded tree when no environment can terminate it", async () => {
		const { base, head } = scenario();
		const database = await crashed(base, head);
		const { harness, root } = await openOn(database, false);
		const [pending] = await liveChecks(harness);
		await recordTree(root, pending!.record.id);
		const run = await runChecks(harness, await input(base, head, root.id, trusted), context);
		expect(run.records).toMatchObject([
			{ status: "failed", error: "no environment to terminate a mutation process tree" },
		]);
	});

	it("ends the recorded processes before retiring a crashed mutation task", async () => {
		const { base, head } = scenario();
		const database = await crashed(base, head);
		const { harness, root } = await openOn(database);
		const [pending] = await liveChecks(harness);
		await recordTree(root, pending!.record.id);
		const kills = fakeProcesses(alive.map((entry) => ({ ...entry })));
		await runChecks(harness, await input(base, head, root.id, revoked), context);
		expect(kills).toEqual([
			[4242, "SIGTERM"],
			[4243, "SIGTERM"],
		]);
	});

	it("resumes and runs the task a crash left pending when the next review keeps the writer trusted", async () => {
		const { base, head } = scenario();
		const database = await crashed(base, head);
		const { harness, root } = await openOn(database);
		const run = await runChecks(harness, await input(base, head, root.id, trusted), context);
		expect(run.records).toMatchObject([{ name: "static.mutation", status: "ran", findings: 1 }]);
		expect(runs()).toBe(1);
		const [finding] = await readFindings(harness, root.id, revisionKey({ base, head }), context);
		expect(finding).toMatchObject({ ruleId: "mutation/untested-behaviour" });
	});

	it("runs again, and does not wait on the retired task, when trust is revoked and then restored", async () => {
		const { base, head } = scenario();
		const database = await crashed(base, head);
		const { harness, root } = await openOn(database);
		await runChecks(harness, await input(base, head, root.id, revoked), context);
		expect(runs()).toBe(0);
		const restored = await runChecks(harness, await input(base, head, root.id, trusted), context);
		expect(restored.records).toMatchObject([{ name: "static.mutation", status: "ran", findings: 1 }]);
		expect(runs()).toBe(1);
	});

	it("keeps a task from running head code once another review has taken the revision, however it got to the store", async () => {
		const { base, head } = scenario();
		const database = await crashed(base, head);
		const { harness, root } = await openOn(database);
		const [pending] = await liveChecks(harness);
		await root.commit(async (tx) => {
			const document = await tx.doc(ChecksDocument, root.id);
			document.owners = { [revisionKey({ base, head })]: "a newer review of this revision" };
		}, context);
		expect(await outcomeOf(harness, pending!.record.id)).toEqual({ status: "aborted" });
		expect(runs()).toBe(0);
		expect(await readFindings(harness, root.id, revisionKey({ base, head }), context)).toEqual([]);
	});

	it("runs the task of a document an earlier build wrote, which records no owner and retires no task", async () => {
		const { base, head } = scenario();
		const database = await crashed(base, head);
		const { harness, root } = await openOn(database);
		await root.commit(async (tx) => {
			delete (await tx.doc(ChecksDocument, root.id)).owners;
		}, context);
		const [pending] = await liveChecks(harness);
		expect(await outcomeOf(harness, pending!.record.id)).toMatchObject({ status: "completed" });
		expect(runs()).toBe(1);
	});

	it("writes no findings from a run whose tests finished after another review took the revision", async () => {
		const { base, head } = scenario(true);
		const { harness, root } = await openOn(join(artifacts, "state.sqlite"));
		const run = runChecks(harness, await input(base, head, root.id, trusted), context);
		const deadline = Date.now() + 20_000;
		while (runs() === 0) {
			if (Date.now() > deadline) throw new Error("Stryker never started");
			await sleep(20);
		}
		const [running] = await liveChecks(harness);
		await root.commit(async (tx) => {
			const document = await tx.doc(ChecksDocument, root.id);
			document.owners = { [revisionKey({ base, head })]: "a newer review of this revision" };
		}, context);
		writeFileSync(join(artifacts, "release"), "");
		await run.catch(() => undefined);
		expect(await outcomeOf(harness, running!.record.id)).toEqual({ status: "aborted" });
		expect(await readFindings(harness, root.id, revisionKey({ base, head }), context)).toEqual([]);
		expect(runs()).toBe(1);
	});

	it("aborts a task whose tests are running when another review takes the revision, without waiting for them", async () => {
		const { base, head } = scenario(true);
		const { harness, root } = await openOn(join(artifacts, "state.sqlite"));
		const first = runChecks(harness, await input(base, head, root.id, trusted), context);
		const settled = first.then(
			() => "settled",
			() => "settled",
		);
		const deadline = Date.now() + 20_000;
		while (runs() === 0) {
			if (Date.now() > deadline) throw new Error("Stryker never started");
			await sleep(20);
		}
		const [running] = await liveChecks(harness);
		const second = await runChecks(harness, await input(base, head, root.id, revoked), context);
		expect(second.records).toMatchObject([{ status: "skipped", cause: "untrustedWriter" }]);
		const outcome = await Promise.race([settled, sleep(15_000).then(() => "still running")]);
		expect(outcome).toBe("settled");
		expect((await first).records).toMatchObject([{ name: "static.mutation", status: "failed", reason: "aborted" }]);
		expect(await outcomeOf(harness, running!.record.id)).toEqual({ status: "aborted" });
		expect(await readFindings(harness, root.id, revisionKey({ base, head }), context)).toEqual([]);
	});

	it("leaves another tier's run alone: a run without the mutation check takes no authority", async () => {
		const { base, head } = scenario(true);
		const { harness, root } = await openOn(join(artifacts, "state.sqlite"));
		const { config } = await loadConfig(repo, source(base), "");
		const mutation = runChecks(harness, await input(base, head, root.id, trusted), context);
		const deadline = Date.now() + 20_000;
		while (runs() === 0) {
			if (Date.now() > deadline) throw new Error("Stryker never started");
			await sleep(20);
		}
		const other = await runChecks(
			harness,
			{
				rootConversationId: root.id,
				changeset: await Changeset.resolve(repo, `${base}..${head}`),
				config: { ...config, tiers: { ...config.tiers, quick: ["guardrails"] } },
				source: source(base),
				tier: "quick",
			},
			context,
		);
		expect(other.records).toMatchObject([{ name: "guardrails", status: "ran" }]);
		writeFileSync(join(artifacts, "release"), "");
		expect((await mutation).records).toMatchObject([{ name: "static.mutation", status: "ran", findings: 1 }]);
		expect((await readFindings(harness, root.id, revisionKey({ base, head }), context)).length).toBe(1);
	});
});
