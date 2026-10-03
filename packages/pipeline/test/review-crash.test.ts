import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultConfig, loadLenses, resolveRange } from "@melian-agent/core";
import {
	backgroundContext as context,
	createReviewRegistry,
	type Harness,
	type Message,
	openHarness,
	openSqliteStorage,
	readFindings,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIn } from "./fixtures/repo.ts";
import { count, crashFinding, crashLenses, crashRepository, readEvents } from "./fixtures/review-scenario.ts";

const crashScript = fileURLToPath(new URL("./fixtures/review-crash.ts", import.meta.url));

let dir: string;
let repo: string;
let harness: Harness | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-review-crash-"));
	repo = crashRepository();
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	rmSync(dir, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

async function killWhen(
	scenario: "finding" | "request",
	reached: (events: ReturnType<typeof readEvents>) => boolean,
	database: string,
	log: string,
): Promise<void> {
	// The condition resolves workspace packages to their sources, as Vitest does, rather than to a stale or absent build.
	const child = spawn(
		process.execPath,
		["--conditions=@melian-agent/source", crashScript, scenario, repo, database, log],
		{
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<string | number | null>((resolve) =>
		child.on("exit", (code, signal) => resolve(signal ?? code)),
	);
	const deadline = Date.now() + 15_000;
	try {
		while (!reached(readEvents(log))) {
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(`crash script exited before the kill point:\n${stderr}`);
			if (Date.now() > deadline) throw new Error(`crash script never reached the kill point:\n${stderr}`);
			await sleep(20);
		}
	} finally {
		child.kill("SIGKILL");
	}
	expect(await exited).toBe("SIGKILL");
}

function toolResults(messages: readonly Message[]): string[] {
	return messages.filter((message) => message.role === "toolResult").map(textOf);
}

describe("report_finding across a crash", { timeout: 30_000 }, () => {
	it("replays and accepts a correction at exactly the lens's full budget", async () => {
		const database = join(dir, "review.sqlite");
		const log = join(dir, "review.jsonl");
		await killWhen("finding", (events) => count(events, "finding-committed") === 1, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const corrected = { ...crashFinding, explanation: { ...crashFinding.explanation, what: "Corrected." } };
		const requests = scriptConversations(fake, [
			{
				match: "You are the correctness reviewer",
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", corrected), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		harness.resume();
		const lensTask = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "melian.lenses");
		expect(lensTask).toBeDefined();
		const settled = await harness.waitForTask(lensTask!.record.id, context);

		expect(settled.state.outcome.status).toBe("completed");
		const [replayed, correction] = requests["You are the correctness reviewer"]!;
		const [first] = toolResults(replayed!);
		expect(first).toMatch(/^recorded finding [0-9a-f]{16}$/);
		expect(toolResults(correction!).at(-1)).toBe(first);
		const root = await harness.root(context);
		const findings = await readFindings(harness, root.id, gitIn(repo, "rev-parse", "feature"), context);
		expect(findings.map((finding) => finding.message.text)).toEqual(["Corrected."]);
	});

	it("attaches a repeat call to the crashed review, so each lens asks its model once", async () => {
		const database = join(dir, "repeat.sqlite");
		const log = join(dir, "repeat.jsonl");
		await killWhen("request", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const heavy = fake.ref("heavy");
		await reviewChangeset({
			harness,
			changeset: await resolveRange(repo, "main...feature"),
			config: { ...defaultConfig, models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } } },
			lenses: crashLenses(await loadLenses(repo, { kind: "worktree" }, ["src/user.ts"])),
			standards: [],
			models: fake.models,
		});

		expect(requests["You are the correctness reviewer"]).toHaveLength(1);
		expect(requests["You are the contracts reviewer"]).toHaveLength(1);
		expect(fake.provider.state.callCount).toBe(2);
		const lensTasks = (await harness.inspect(context)).tasks.filter((task) => task.record.kind === "melian.lenses");
		expect(lensTasks).toEqual([]);
	});
});
