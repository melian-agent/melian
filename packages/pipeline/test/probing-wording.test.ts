import { readdirSync, rmSync } from "node:fs";
import { Changeset, defaultConfig, Lens, lensProbingWording, type MelianConfig, Standards } from "@melian-agent/core";
import { createMemoryStorage, openReviewHarness, type ReviewHarness, reviewChangeset } from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
	systemPromptOf,
	textOf,
	unconfinedSandbox,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordPlan, reportFinding, runProbe, skipAttack, verifierInjectionPolicy } from "../src/lens-tools.ts";
import { injectionPolicy } from "../src/untrusted.ts";
import { verifierInstructions } from "../src/verification-instructions.ts";
import { baseAndHead } from "./fixtures/repo.ts";

// The experiment of issue #483 on the fake model: the tests lens at a level that probes, with wording of its own, so its
// planner, prober and verifier read nothing of the trust-boundary lens's.

let repo: string;
let harness: ReviewHarness | undefined;

beforeEach(() => {
	repo = baseAndHead(
		{
			"src/total.ts": "export function total(price: number, count: number) {\n\treturn price * count;\n}\n",
			"test/total.test.ts":
				'import { total } from "../src/total.ts";\nif (total(2, 3) !== 6) throw new Error("total");\n',
		},
		{
			"src/total.ts":
				"export function total(price: number, count: number) {\n\tif (count > 10) return price * count * 0.9;\n\treturn price * count;\n}\n",
		},
	);
});

afterEach(async () => {
	await harness?.close();
	harness = undefined;
	rmSync(repo, { recursive: true, force: true });
});

const attack = {
	target: "src/total.ts line 2, run by test/total.test.ts",
	reason: "no test buys more than ten, so no test reaches the discount",
	passing: "with the discount line deleted the test fails, and the probe prints failed",
	failing: "with the discount line deleted the test still passes, and the probe prints passed",
};

const probe =
	'console.log("changed: deleted line 2 of src/total.ts");\nconsole.log("the test passed unchanged and passed changed");\nprocess.exit(1);\n';

function call(name: string, args: Record<string, unknown>) {
	return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
		stopReason: "toolUse",
	});
}

const planning = [call("record_plan", { attacks: [attack] }), fauxAssistantMessage("Planned 1 attack.")];

const probing: ScriptedReply[] = [
	call("run_probe", { attack: 1, script: probe }),
	(messages) => {
		const last = messages.findLastIndex((message) => message.role === "assistant");
		const ran = messages
			.slice(last + 1)
			.filter((message) => message.role === "toolResult")
			.map(textOf)
			.join("\n");
		return call("report_finding", {
			file: "src/total.ts",
			line: 2,
			rule: "untested-behaviour",
			severity: "P2",
			explanation: {
				what: "the discount has no test",
				why: "deleting it passes every test",
				fix: "test a count past ten",
			},
			failureScenario: "deleting the discount on line 2 passes test/total.test.ts, so a regression ships",
			evidence: [{ file: "src/total.ts", line: 2, role: "cause" }],
			probe: /probe (p[0-9]+)/.exec(ran)?.[1] ?? "p0",
		});
	},
	fauxAssistantMessage("Reported 1 finding."),
];

const planner = "Your role at this level: the attack planner";
const prober = "You are the prober for the tests lens";

// Reviews the change with the tests lens at a level that probes, its planner and prober answering from the scripts.
async function reviewTests(planned: ScriptedReply[], probed: ScriptedReply[]) {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const policy = { kind: "revision", commit: changeset.revision.base } as const;
	const paths = changeset.revision.paths();
	const fake = createFakeModels();
	const ref = fake.ref();
	const requests = scriptConversations(fake, [
		{ match: planner, replies: planned },
		{ match: prober, replies: probed },
	]);
	harness = await openReviewHarness(createMemoryStorage(), fake.review, {
		retry: false,
		probeSandbox: unconfinedSandbox(),
	});
	const lenses = (await Lens.load(repo, policy, paths)).map((lens) =>
		lens.name === "tests"
			? Lens.from({ ...lens.toJSON(), levels: { ...lens.levels, deep: { ...lens.level("deep"), probe: {} } } })
			: lens,
	);
	const { verdict } = await reviewChangeset({
		harness,
		changeset,
		config: {
			...defaultConfig,
			tiers: { full: ["lens.tests"] },
			lenses: { tests: { level: { floor: "deep" } } },
			models: { heavy: { model: `${ref.provider}/${ref.modelId}` } },
		},
		lenses,
		standards: await Standards.load(repo, policy, paths),
		models: fake.review,
		writer: { trusted: true, by: "reviewer" },
	});
	return { verdict, requests };
}

// The words that name the trust-boundary lens's concern, which no other lens's probing turn should carry.
const boundaryWords = /boundary|untrusted|hostile|trust-boundary/i;

describe("the tests lens at a level that probes", () => {
	it("plans, probes and is judged in wording of its own, its finding resting on a probe run again", async () => {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const policy = { kind: "revision", commit: changeset.revision.base } as const;
		const paths = changeset.revision.paths();
		const fake = createFakeModels();
		const ref = fake.ref();
		const config: MelianConfig = {
			...defaultConfig,
			tiers: { full: ["lens.tests"] },
			lenses: { tests: { level: { floor: "deep" } } },
			models: { heavy: { model: `${ref.provider}/${ref.modelId}` } },
		};
		const requests = scriptConversations(fake, [
			{ match: planner, replies: planning },
			{ match: prober, replies: probing },
		]);
		const inHead: string[] = [];
		harness = await openReviewHarness(createMemoryStorage(), fake.review, {
			retry: false,
			probeSandbox: unconfinedSandbox((command) => {
				const tree = /^cd '([^']+\/tree)'/.exec(command)?.[1];
				if (tree !== undefined && readdirSync(tree).length > 0) inHead.push(command);
				return command;
			}),
		});
		const lenses = (await Lens.load(repo, policy, paths)).map((lens) =>
			lens.name === "tests"
				? Lens.from({ ...lens.toJSON(), levels: { ...lens.levels, deep: { ...lens.level("deep"), probe: {} } } })
				: lens,
		);
		const { verdict } = await reviewChangeset({
			harness,
			changeset,
			config,
			lenses,
			standards: await Standards.load(repo, policy, paths),
			models: fake.review,
			writer: { trusted: true, by: "reviewer" },
		});

		const found = verdict.counted();
		expect(
			found.map((each) => [
				each.properties.path,
				each.ruleId,
				each.properties.source.check,
				each.properties.verification?.verdict,
			]),
		).toEqual([["src/total.ts", "untested-behaviour", "lens.tests", "confirmed"]]);
		// The prober's probe, then the verifier's rerun of it.
		expect(inHead).toHaveLength(2);

		const own = lensProbingWording.get("tests")!;
		const plannerPrompt = systemPromptOf(requests[planner]![0]!);
		expect(plannerPrompt).toContain(own.plannerPlan);
		const proberPrompt = systemPromptOf(requests[prober]![0]!);
		expect(proberPrompt).toContain("node node_modules/vitest/vitest.mjs --run <file>");
		expect(proberPrompt).toContain(own.findings);
		const verifier = requests["Melian adversarial verifier"]!;
		const judged = systemPromptOf(verifier[0]!);
		expect(judged).toContain("When Melian ran it again it failed, exiting 1.");
		expect(judged).toContain(own.judge);
		expect(judged).toContain(attack.reason);

		// Everything the planner, prober and verifier were sent as a system prompt or an input, less what every lens and
		// every verifier is sent alike: the injection policies and the verifier's instructions, which name boundaries, and
		// the review's boundaries, which hold the change and the plan as data. The review draws its own nonce.
		const nonce = /<untrusted-([0-9a-f]+)/.exec(plannerPrompt)![1]!;
		const quoted = new RegExp(`<untrusted-${nonce}[^>]*>[^]*?</untrusted-${nonce}>`, "g");
		const fixed = (messages: Parameters<typeof systemPromptOf>[0]) =>
			messages
				.filter(({ role }) => role === "system" || role === "user")
				.map(textOf)
				.join("\n")
				.replaceAll(injectionPolicy(nonce), "")
				.replaceAll(verifierInjectionPolicy(nonce), "")
				.replaceAll(verifierInstructions, "")
				.replace(quoted, "");
		const sent = [planner, prober, "Melian adversarial verifier"].flatMap((who) => requests[who]!.map(fixed));
		expect(sent.length).toBeGreaterThanOrEqual(3);
		expect(sent.filter((text) => boundaryWords.test(text)).map((text) => text.match(boundaryWords)![0])).toEqual([]);
	});

	it("reminds a tests planner that recorded no plan in the tests lens's own words", async () => {
		const { requests } = await reviewTests([fauxAssistantMessage("Nothing."), ...planning], probing);
		const reminder = textOf(requests[planner]![1]!.at(-1)!);
		expect(reminder).toBe(lensProbingWording.get("tests")!.recordPlan);
	});

	it("has a probe whose test fails unchanged exit 125, which reports no finding and refutes none", async () => {
		const baseline =
			'console.log("unchanged: test/total.test.ts failed: Cannot find module vitest");\nprocess.exit(125);\n';
		const { verdict, requests } = await reviewTests(planning, [
			call("run_probe", { attack: 1, script: baseline }),
			(messages) =>
				call("report_finding", {
					file: "src/total.ts",
					line: 2,
					rule: "untested-behaviour",
					severity: "P2",
					explanation: { what: "a refutation", why: "the probe ended", fix: "none" },
					failureScenario: "the unchanged test fails, so the probe shows nothing about line 2",
					evidence: [{ file: "src/total.ts", line: 2, role: "cause" }],
					probe: /probe (p[0-9]+)/.exec(messages.map(textOf).join("\n"))?.[1] ?? "p0",
					refuted: "0123456789abcdef",
				}),
			fauxAssistantMessage("The unchanged test fails, so I report nothing."),
		]);

		const proberPrompt = systemPromptOf(requests[prober]![0]!);
		expect(proberPrompt).toContain(
			"When the test already fails on the unchanged copy, the probe cannot show whether the test covers the behaviour: print what it printed, exit 125, and report no finding.",
		);
		expect(proberPrompt).toContain("exit 0 when it fails, its passing outcome.");
		const answered = requests[prober]!.at(-1)!.map(textOf).join("\n");
		expect(answered).toContain(
			"did not pass, so it shows no finding wrong: refute a finding only with a probe that exited 0",
		);
		expect(verdict.counted()).toEqual([]);
		expect(JSON.stringify(verdict)).not.toContain("0123456789abcdef");
	});

	it("offers a planner and a prober tools whose descriptions name no boundary", () => {
		for (const tool of [recordPlan, runProbe, skipAttack, reportFinding])
			expect(JSON.stringify({ description: tool.description, parameters: tool.parameters })).not.toMatch(
				boundaryWords,
			);
	});
});
