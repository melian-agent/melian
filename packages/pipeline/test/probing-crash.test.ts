import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { backgroundContext as context } from "@melian-agent/pipeline";
import { fauxAssistantMessage, fauxToolCall, type ScriptedReply } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probingReview } from "./fixtures/probing-scenario.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";
import { count, readEvents } from "./fixtures/spike.ts";

const crashScript = fileURLToPath(new URL("./fixtures/probing-crash.ts", import.meta.url));

let dir: string;
let repo: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-probing-crash-"));
	repo = crashRepository();
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

// Starts the crash script and kills it, by its own handle, once the prober has asked `second` for its answer.
async function crashInProber(database: string, log: string): Promise<void> {
	const child = spawn(process.execPath, ["--conditions=@melian-agent/source", crashScript, repo, database, log], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<string | number | null>((resolve) =>
		child.on("exit", (code, signal) => resolve(signal ?? code)),
	);
	const deadline = Date.now() + 30_000;
	try {
		while (count(readEvents(log), "prober-asked") === 0) {
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

describe("a level that probes across a crash", { timeout: 60_000 }, () => {
	it("resumes the planner and the prober on the models they failed over to, and creates no second prober", async () => {
		const database = join(dir, "state.sqlite");
		const log = join(dir, "events.jsonl");
		await crashInProber(database, log);
		const asked: string[] = [];
		const on =
			(name: string, reply: ScriptedReply): ScriptedReply =>
			(messages, model) => {
				asked.push(`${name} ${model}`);
				return typeof reply === "function" ? reply(messages, model) : reply;
			};
		const refused = fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage_limit_reached" });
		const { harness, review } = await probingReview(repo, database, {
			first: { planner: [on("planner", refused)], prober: [on("prober", refused)] },
			second: {
				planner: [on("planner", fauxAssistantMessage("Planned 1 attack."))],
				prober: [
					on(
						"prober",
						fauxAssistantMessage([fauxToolCall("skip_attack", { attack: 1, reason: "r" })], {
							stopReason: "toolUse",
						}),
					),
					on("prober", fauxAssistantMessage("Done.")),
				],
			},
		});
		try {
			// Each role resumes from the attempt its checkpoint reached, so the provider each already left stays locked.
			expect(await harness.resumedProviders(context)).toEqual(["second"]);
			const { verdict } = await review();
			const record = [...(verdict.ran ?? []), ...verdict.notRun].find(({ name }) => name === "lens.trust-boundary")!;
			expect(record).toMatchObject({ status: "ran", level: "deep" });
			expect(record.reason).toContain("it planned 1 attack and ran 0 probes in 0.0 s, and skipped 1 attack");
			expect(asked).toEqual(["prober b", "prober b"]);
		} finally {
			await harness.close(context);
		}
	});
});
