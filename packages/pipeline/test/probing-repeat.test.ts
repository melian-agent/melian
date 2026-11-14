import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundContext as context } from "@melian-agent/pipeline";
import { fauxAssistantMessage, fauxToolCall } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plannerMatch, probingReview } from "./fixtures/probing-scenario.ts";
import { crashRepository } from "./fixtures/review-scenario.ts";

let dir: string;
let repo: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-probing-repeat-"));
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

const contracts = { lens: "contracts", match: "You are the contracts reviewer" };

// Reviews one head on one store twice and says whether the second review asked the planner again.
async function plannedAgain(plain?: typeof contracts): Promise<boolean> {
	const database = join(dir, "state.sqlite");
	for (const index of [0, 1]) {
		const { harness, review, requests } = await probingReview(repo, database, planNone(), undefined, plain);
		try {
			await review();
			if (index === 1) return (requests[plannerMatch] ?? []).length > 0;
		} finally {
			await harness.close(context);
		}
	}
	throw new Error("unreachable");
}

describe("a repeat review of a level that probes", { timeout: 60_000 }, () => {
	it("plans and probes again rather than reuse the first review's finished probing run", async () => {
		expect(await plannedAgain()).toBe(true);
	});

	it("plans again when the review's other lens does not probe", async () => {
		expect(await plannedAgain(contracts)).toBe(true);
	});
});
