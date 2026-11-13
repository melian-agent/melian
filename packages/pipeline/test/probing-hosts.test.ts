import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundContext as context } from "@melian-agent/pipeline";
import { fauxAssistantMessage, fauxToolCall, unconfinedSandbox } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProbeSandbox } from "../src/probe.ts";
import { plannerMatch, probingReview } from "./fixtures/probing-scenario.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

let dir: string;
let repo: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-probing-hosts-"));
	repo = crashRepository();
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

const planNone = () => ({
	first: {
		planner: [
			fauxAssistantMessage([fauxToolCall("record_plan", { attacks: [] })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Planned 0 attacks."),
		],
		prober: [],
	},
	second: { planner: [], prober: [] },
});

// Reviews one head on one store, first under `before` and then under `after`, and says whether the second review asked
// the planner again rather than reusing the first review's probing run.
async function plannedAgain(before: ProbeSandbox, after: ProbeSandbox): Promise<boolean> {
	const database = join(dir, "state.sqlite");
	for (const [sandbox, index] of [
		[before, 0],
		[after, 1],
	] as const) {
		const { harness, review, requests } = await probingReview(repo, database, planNone(), sandbox);
		try {
			await review();
			if (index === 1) return (requests[plannerMatch] ?? []).length > 0;
		} finally {
			await harness.close(context);
		}
	}
	throw new Error("unreachable");
}

describe("a probing run's reuse across hosts", { timeout: 60_000 }, () => {
	it("runs a probing level again on a host whose platform differs", async () => {
		const here = unconfinedSandbox();
		const other: ProbeSandbox = { ...unconfinedSandbox(), platform: here.platform === "linux" ? "darwin" : "linux" };
		expect(await plannedAgain(here, other)).toBe(true);
	});

	it("runs a probing level again under a sandbox of another kind", async () => {
		expect(await plannedAgain(unconfinedSandbox(), { ...unconfinedSandbox(), kind: "another" } as ProbeSandbox)).toBe(
			true,
		);
	});

	it("reuses the probing run when the platform and the sandbox agree", async () => {
		expect(await plannedAgain(unconfinedSandbox(), unconfinedSandbox())).toBe(false);
	});
});
