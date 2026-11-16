import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, Revision } from "@melian-agent/core";
import { backgroundContext as context } from "@melian-agent/pipeline";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	systemPromptOf,
	textOf,
	unconfinedSandbox,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Probing from "../src/probing.ts";
import { ProbeReruns, probingWording } from "../src/probing.ts";
import { plannerMatch, proberMatch, probingReview } from "./fixtures/probing-scenario.ts";
import { crashFinding, crashRepository } from "./fixtures/review-scenario.ts";

// The module's table is frozen; a copy lets a test change one string, as a release would.
vi.mock("../src/probing.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Probing>();
	return { ...actual, probingWording: { ...actual.probingWording } };
});

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

const verifierMatch = "Melian adversarial verifier";

const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });

const planNone = () => ({
	first: { planner: [call("record_plan", { attacks: [] }), fauxAssistantMessage("Planned 0 attacks.")], prober: [] },
	second: { planner: [], prober: [] },
});

// A plan of one attack, a probe that fails for it, and a finding that cites the probe.
const planOne = () => ({
	first: {
		planner: [
			call("record_plan", {
				attacks: [
					{
						target: "src/user.ts managerName()",
						reason: "a user without a manager reaches the dereference",
						passing: "managerName returns a name and prints held",
						failing: "managerName throws and prints crashed",
					},
				],
			}),
			fauxAssistantMessage("Planned 1 attack."),
		],
		prober: [
			call("run_probe", { attack: 1, script: 'console.log("crashed");\nprocess.exit(1);\n' }),
			((messages) => {
				const results = messages.filter((message) => message.role === "toolResult").map(textOf);
				const probe = /probe (p[0-9]+)/.exec(results.at(-1) ?? "")?.[1] ?? "p0";
				return call("report_finding", { ...crashFinding, rule: "head-controls-judge", probe });
			}) as ScriptedReply,
			fauxAssistantMessage("Reported 1 finding."),
		],
	},
	second: { planner: [], prober: [] },
});

const contracts = { lens: "contracts", match: "You are the contracts reviewer" };

type Second = {
	// Replaces the sandbox's fields for the second review.
	readonly sandbox?: { readonly kind: string };
	readonly plain?: typeof contracts & { readonly extra?: string };
	// Runs once the first review has ended.
	readonly before?: () => void;
};

// Reviews one head twice, each on its own harness over one SQLite store, and says what each review asked, how many
// probes ran in the head's tree, its counted findings, and the probe reruns stored after it.
async function twice(plan: typeof planOne, plain?: typeof contracts, second: Second = {}) {
	const database = join(dir, "state.sqlite");
	const at = Revision.key((await Changeset.resolve(repo, "main...feature")).revision);
	const reviews = [];
	for (const index of [0, 1]) {
		if (index === 1) second.before?.();
		const lens = index === 1 && second.plain !== undefined ? second.plain : plain;
		let probes = 0;
		// A probe runs in a tree of the head; the empty probe that checks the sandbox runs in one that holds nothing.
		const sandbox = {
			...unconfinedSandbox((command) => {
				const tree = /^cd '([^']+\/tree)'/.exec(command)?.[1];
				if (tree !== undefined && readdirSync(tree).length > 0) probes++;
				return command;
			}),
			...(index === 1 ? second.sandbox : {}),
		};
		const { harness, review, requests } = await probingReview(repo, database, plan(), sandbox, lens);
		try {
			const { verdict } = await review();
			const asked = (match: string) => (requests[match] ?? []).length;
			reviews.push({
				planner: asked(plannerMatch),
				prober: asked(proberMatch),
				verifier: requests[verifierMatch] ?? [],
				plain: lens === undefined ? 0 : asked(lens.match),
				probes,
				findings: verdict.counted(),
				reruns: (await harness.harness.snapshot(ProbeReruns, (await harness.harness.root(context)).id, context))
					?.runs[at],
			});
		} finally {
			await harness.close(context);
		}
	}
	return reviews as [(typeof reviews)[number], (typeof reviews)[number]];
}

describe("a repeat review of a level that probes", { timeout: 60_000 }, () => {
	it("reuses the first review's finished probing run, asking no model and running no probe", async () => {
		const [first, again] = await twice(planOne);
		expect(first).toMatchObject({ planner: 2, prober: 3, probes: 2 });
		expect(first.verifier.length).toBeGreaterThan(0);
		expect(first.findings.map((each) => [each.ruleId, each.properties.verification?.verdict])).toEqual([
			["head-controls-judge", "confirmed"],
		]);
		expect(again).toMatchObject({ planner: 0, prober: 0, verifier: [], probes: 0 });
		expect(again.findings).toEqual(first.findings);
		expect(again.reruns).toEqual(first.reruns);
	});

	it("copies the probing run when another lens's request changed, and judges its finding on the stored rerun", async () => {
		const [first, again] = await twice(planOne, contracts, { plain: { ...contracts, extra: "Read every caller." } });
		expect(first).toMatchObject({ plain: 1, probes: 2 });
		expect(again).toMatchObject({ planner: 0, prober: 0, plain: 1, probes: 0 });
		// The verifier judges the copied claim again, with the probe its run cites and the run Melian stored for it.
		const judged = systemPromptOf(again.verifier[0]!);
		expect(judged).toContain("Claim c1 rests on probe p");
		expect(judged).toContain("When Melian ran it again it failed, exiting 1.");
		expect(again.findings.map((each) => [each.id, each.properties.verification?.verdict])).toEqual(
			first.findings.map((each) => [each.id, "confirmed"]),
		);
		expect(again.reruns).toEqual(first.reruns);
	});

	it("copies the review's other lens beside the probing run, and asks neither again", async () => {
		const [, again] = await twice(planNone, contracts);
		expect(again).toMatchObject({ planner: 0, plain: 0 });
	});

	it("plans and probes again under another sandbox, which the probing host names", async () => {
		const [, again] = await twice(planOne, undefined, { sandbox: { kind: "another" } });
		expect(again).toMatchObject({ planner: 2, prober: 3, probes: 2 });
	});

	it("plans again when a probing wording string changed", async () => {
		const wording = probingWording as Record<string, string>;
		const original = wording.planAnswer!;
		try {
			const [, again] = await twice(planNone, undefined, {
				before: () => {
					wording.planAnswer = `${original} Answer briefly.`;
				},
			});
			expect(again.planner).toBe(2);
		} finally {
			wording.planAnswer = original;
		}
	});
});
