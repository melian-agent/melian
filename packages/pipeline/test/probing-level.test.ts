import { rmSync } from "node:fs";
import {
	Changeset,
	type CheckRecord,
	defaultConfig,
	Lens,
	type LensBudget,
	type LensProbing,
	type MelianConfig,
	ReviewPlan,
	Revision,
	Standards,
} from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import {
	createMemoryStorage,
	openReviewHarness,
	type ProbeSandbox,
	ReviewError,
	type ReviewHarness,
	reviewChangeset,
	type Storage,
	TelemetryReader,
} from "@melian-agent/pipeline";
import {
	type ConversationScript,
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
	systemPromptOf,
	textOf,
	unconfinedSandbox,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planInputs } from "../src/models.ts";
import { baseAndHead, gitIn, writeFiles } from "./fixtures/repo.ts";

// A level that probes, end to end on the fake model: the planner records the plan, the prober runs probes under a
// sandbox that runs them unconfined, since every probe here is the test's own, and the verifier judges what they show.

let repo: string;
let harness: ReviewHarness | undefined;
let storage: Storage;

beforeEach(() => {
	repo = baseAndHead(
		{
			"src/load.ts": "export function load(path: string) {\n\treturn path;\n}\n",
			"docs/decisions/2026-01-01-paths-stay-inside.md":
				"# Paths stay inside\n\nStatus: accepted.\n\nA path an author names stays inside the repository.\n",
		},
		{
			"src/load.ts":
				'import { readFileSync } from "node:fs";\nexport function load(path: string) {\n\treturn readFileSync(path, "utf8");\n}\n',
			"fixture/leak.txt": "LEAK\n",
		},
	);
});

afterEach(async () => {
	await harness?.close();
	harness = undefined;
	rmSync(repo, { recursive: true, force: true });
});

const planner = "Your role at this level: the attack planner";
const prober = "You are the prober for the trust-boundary lens";

const attack = {
	target: "src/load.ts load()",
	reason: "an author's path reaches readFileSync unconfined",
	passing: "the read stays inside the repository and prints held",
	failing: "the read returns a file outside where it belongs and prints LEAK",
};

const failing =
	'import { readFileSync } from "node:fs";\nconst text = readFileSync("fixture/leak.txt", "utf8").trim();\nconsole.log(text);\nprocess.exit(text === "LEAK" ? 1 : 0);\n';
const passing = 'console.log("held");\nprocess.exit(0);\n';

// The text of every tool result answering the request's last assistant turn.
function lastResults(messages: Parameters<Extract<ScriptedReply, (...args: never[]) => unknown>>[0]): string {
	const last = messages.findLastIndex((message) => message.role === "assistant");
	return messages
		.slice(last + 1)
		.filter((message) => message.role === "toolResult")
		.map(textOf)
		.join("\n");
}

function call(name: string, args: Record<string, unknown>) {
	return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
		stopReason: "toolUse",
	});
}

const finding = (probe: string) => ({
	file: "src/load.ts",
	line: 3,
	rule: "path-traversal",
	severity: "P1",
	explanation: { what: "load reads any path", why: "the path is the author's", fix: "confine it" },
	failureScenario: 'load("fixture/leak.txt") returns LEAK, a file the caller never meant to expose',
	evidence: [{ file: "src/load.ts", line: 3, role: "cause" }],
	probe,
});

// The prober's turns: run `script` for attack 1, report a finding with the probe it ran, then finish.
function probing(script: string, extra: ScriptedReply[] = []): ScriptedReply[] {
	return [
		call("run_probe", { attack: 1, script }),
		(messages) => {
			const id = /probe (p[0-9]+)/.exec(lastResults(messages))?.[1] ?? "p0";
			return call("report_finding", finding(id));
		},
		...extra,
		fauxAssistantMessage("Reported 1 finding."),
	];
}

type ReviewOptions = Parameters<typeof reviewChangeset>[0];

async function review(
	scripts: { planner: ScriptedReply[]; prober: ScriptedReply[]; others?: ConversationScript[] },
	options: {
		writer?: ReviewOptions["writer"];
		config?: Partial<MelianConfig>;
		rewrite?: (command: string) => string;
		sandbox?: ProbeSandbox;
		// Rewrites the trust-boundary lens, such as its deep level's probe.
		lens?: (lens: Lens) => Lens;
		fake?: FakeModels;
		decider?: ReviewOptions["decider"];
		plan?: (config: MelianConfig, lenses: readonly Lens[], fake: FakeModels) => Promise<ReviewOptions["plan"]>;
		unlockModels?: ReviewOptions["unlockModels"];
	} = {},
) {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const policy = { kind: "revision", commit: changeset.revision.base } as const;
	const paths = changeset.revision.paths();
	const fake = options.fake ?? createFakeModels();
	const ref = fake.ref();
	const config: MelianConfig = {
		...defaultConfig,
		tiers: { full: ["lens.trust-boundary"] },
		lenses: { "trust-boundary": { level: { floor: "deep" } } },
		models: { heavy: { model: `${ref.provider}/${ref.modelId}` } },
		...options.config,
	};
	const requests = scriptConversations(fake, [
		{ match: planner, replies: scripts.planner },
		{ match: prober, replies: scripts.prober },
		...(scripts.others ?? []),
	]);
	const sandbox = unconfinedSandbox(options.rewrite);
	storage = harness === undefined ? createMemoryStorage() : storage;
	harness ??= await openReviewHarness(storage, fake.review, {
		retry: false,
		probeSandbox: options.sandbox ?? sandbox,
		...(options.decider === undefined ? {} : { decider: options.decider }),
	});
	const lenses = (await Lens.load(repo, policy, paths)).map((lens) =>
		lens.name === "trust-boundary" && options.lens !== undefined ? options.lens(lens) : lens,
	);
	const plan = await options.plan?.(config, lenses, fake);
	// No policy source, so `config` is every path's, its band among it.
	const run = reviewChangeset({
		harness,
		changeset,
		config,
		lenses,
		standards: await Standards.load(repo, policy, paths),
		models: fake.review,
		writer: "writer" in options ? options.writer : { trusted: true, by: "reviewer" },
		...(options.decider === undefined ? {} : { decider: options.decider }),
		...(plan === undefined ? {} : { plan }),
		...(options.unlockModels === undefined ? {} : { unlockModels: options.unlockModels }),
	});
	return { run, requests, sandbox, changeset };
}

// The trust-boundary lens with its deep level's probe set to `probe`, and its other fields as loaded.
function probingWith(probe: LensProbing, budget?: Partial<LensBudget>) {
	return (lens: Lens) =>
		Lens.from({
			...lens.toJSON(),
			levels: {
				...lens.levels,
				deep: { ...lens.level("deep"), probe, budget: { ...lens.level("deep").budget, ...budget } },
			},
		});
}

async function failure(run: Promise<unknown>): Promise<ReviewError> {
	const error = await run.then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	if (!(error instanceof ReviewError)) throw new Error(`expected a ReviewError, got ${String(error)}`);
	return error;
}

const record = (verdict: { ran?: readonly CheckRecord[]; notRun: readonly CheckRecord[] }) =>
	[...(verdict.ran ?? []), ...verdict.notRun].find(({ name }) => name === "lens.trust-boundary")!;

const plan = [call("record_plan", { attacks: [attack] }), fauxAssistantMessage("Planned 1 attack.")];

describe("a level that probes", () => {
	it("reports a finding only with a probe that failed, and the verifier judges the probe it ran again", async () => {
		const { run, requests, sandbox } = await review({ planner: plan, prober: probing(failing) });
		const { verdict } = await run;
		const found = verdict.counted();
		expect(found.map((each) => [each.properties.path, each.ruleId, each.properties.verification?.verdict])).toEqual([
			["src/load.ts", "path-traversal", "confirmed"],
		]);
		// The empty probe that says probes run here, the prober's, and the verifier's rerun.
		expect(sandbox.asked.filter(({ command }) => command.includes("melian-probe-head-"))).toHaveLength(2);
		const verifier = requests["Melian adversarial verifier"]!;
		const judged = systemPromptOf(verifier[0]!);
		expect(judged).toContain("Claim c1 rests on probe p");
		expect(judged).toContain("When Melian ran it again it failed, exiting 1.");
		expect(judged).toContain(attack.reason);
		expect(judged).toContain("const text = readFileSync");
		// The prober got the plan alone, not the change.
		const probed = requests[prober]![0]!;
		const input = probed
			.filter((message) => message.role === "user")
			.map(textOf)
			.join("\n");
		expect(input).toContain(attack.failing);
		expect(input).not.toContain("readFileSync(path");
		expect(systemPromptOf(probed)).not.toContain("You are the trust-boundary reviewer");
		const record = verdict.ran!.find(({ name }) => name === "lens.trust-boundary")!;
		expect(record).toMatchObject({ status: "ran", level: "deep" });
		expect(record.reason).toMatch(/it planned 1 attack and ran 1 probe in [0-9]+\.[0-9] s/);
	});

	it("refuses a finding whose probe passed, so a probe that shows nothing reports nothing", async () => {
		const { run, requests } = await review({ planner: plan, prober: probing(passing) });
		const { verdict } = await run;
		expect(verdict.counted()).toEqual([]);
		const third = requests[prober]![2]!;
		expect(lastResults(third)).toContain("did not fail, so it shows no defect");
	});

	it("keeps a claim whose probe passes when Melian runs it again from being confirmed", async () => {
		let heads = 0;
		const { run, requests } = await review(
			{ planner: plan, prober: probing(failing) },
			{ rewrite: (command) => (command.includes("melian-probe-head-") && ++heads > 1 ? "exit 0" : command) },
		);
		const error = await run.then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		expect(error).toBeInstanceOf(ReviewError);
		expect((error as ReviewError).code).toBe("verifierFailed");
		const verifier = requests["Melian adversarial verifier"]!;
		expect(systemPromptOf(verifier[0]!)).toContain("When Melian ran it again it passed, exiting 0.");
		expect(lastResults(verifier[1]!)).toContain(
			"did not fail when Melian ran it again, so the claim cannot be confirmed",
		);
	});

	it("reminds a prober once of each attack it left unanswered, and records a lens that still leaves one as ended", async () => {
		const { run, requests } = await review({
			planner: [call("record_plan", { attacks: [attack, { ...attack, target: "src/load.ts again" }] }), plan[1]!],
			prober: [
				call("run_probe", { attack: 1, script: passing }),
				fauxAssistantMessage("Done."),
				fauxAssistantMessage("Still done."),
			],
		});
		const { verdict } = await run;
		const asked = requests[prober]!;
		expect(asked).toHaveLength(3);
		expect(textOf(asked[2]!.at(-1)!)).toContain("Attack 2 has neither a probe nor a skip");
		const record = verdict.notRun.find(({ name }) => name === "lens.trust-boundary")!;
		expect(record.status).toBe("ended");
		expect(record.reason).toContain("its prober left attack 2 with neither a probe nor a skip");
		expect(verdict.status).toBe("not-reviewed");
	});

	it("counts an attack the prober skipped with its reason as answered", async () => {
		const { run } = await review({
			planner: plan,
			prober: [call("skip_attack", { attack: 1, reason: "it needs the network" }), fauxAssistantMessage("Done.")],
		});
		const record = (await run).verdict.ran!.find(({ name }) => name === "lens.trust-boundary")!;
		expect(record).toMatchObject({ status: "ran" });
		expect(record.reason).toContain("it planned 1 attack and ran 0 probes in 0.0 s, and skipped 1 attack");
	});

	it("runs no prober for an empty plan", async () => {
		const { run, requests } = await review({
			planner: [call("record_plan", { attacks: [] }), plan[1]!],
			prober: [],
		});
		const record = (await run).verdict.ran!.find(({ name }) => name === "lens.trust-boundary")!;
		expect(record).toMatchObject({ status: "ran" });
		expect(record.reason).toContain("its planner found no attack to probe");
		expect(requests[prober]).toEqual([]);
	});

	it("reminds a planner that recorded no plan once, and fails the lens when it still records none", async () => {
		const { run, requests } = await review({
			planner: [fauxAssistantMessage("Nothing."), fauxAssistantMessage("Still nothing.")],
			prober: [],
		});
		const error = await run.then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		expect((error as ReviewError).code).toBe("lensFailed");
		expect(textOf(requests[planner]![1]!.at(-1)!)).toContain("You finished without recording the attack plan");
		const record = (error as ReviewError).verdict!.notRun.find(({ name }) => name === "lens.trust-boundary")!;
		expect(record.error).toBe("the planner recorded no attack plan");
	});

	it("runs no probe for a head the host has not allowed, and says so when no other level may run", async () => {
		const { run, requests } = await review(
			{ planner: plan, prober: probing(failing) },
			{ writer: { trusted: false, detail: "octocat has read permission" } },
		);
		const error = await run.then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		expect((error as ReviewError).code).toBe("noAvailableModel");
		expect((error as ReviewError).message).toContain(
			"deep runs probes, which cannot run here: octocat has read permission",
		);
		expect(requests[planner]).toEqual([]);
	});

	it("runs the prober on its own tier, model and time limit, and the planner on the level's", async () => {
		const fake = createFakeModels({ models: [{ id: "planning" }, { id: "probing" }] });
		const seen: { role: string; model: string }[] = [];
		const on =
			(role: string, reply: ScriptedReply): ScriptedReply =>
			(messages, model) => {
				seen.push({ role, model });
				return typeof reply === "function" ? reply(messages, model) : reply;
			};
		const { run, requests } = await review(
			{
				planner: plan.map((reply) => on("planner", reply)),
				prober: [
					on("prober", call("run_probe", { attack: 1, script: "setInterval(() => {}, 1000);\n" })),
					on("prober", fauxAssistantMessage("Reported 0 findings.")),
				],
			},
			{
				fake,
				lens: probingWith({ prober: "light", timeout: 300 }),
				config: {
					models: {
						heavy: { model: `${fake.ref("planning").provider}/planning` },
						light: { model: `${fake.ref("probing").provider}/probing` },
					},
				},
			},
		);
		const { verdict } = await run;
		expect([...new Set(seen.map(({ role, model }) => `${role} ${model}`))]).toEqual([
			"planner planning",
			"prober probing",
		]);
		expect(lastResults(requests[prober]![1]!)).toMatch(
			/probe p[0-9]+ timed out after 0\.3 seconds, which shows nothing/,
		);
		expect(record(verdict)).toMatchObject({ status: "ran", level: "deep" });
	});

	it("fails a review whose prober's tier reaches no model, naming the tier", async () => {
		const { run, requests } = await review({ planner: plan, prober: [] }, { lens: probingWith({ prober: "light" }) });
		const error = await failure(run);
		expect(error.code).toBe("noAvailableModel");
		expect(error.message).toContain("deep's prober runs on light, and");
		expect(requests[planner]).toEqual([]);
	});

	it.each([
		["no writer", {}, undefined, "the host did not say whose head this is"],
		[
			"a writer under a policy that trusts no writer",
			{ trust: { writers: false } },
			{ trusted: true, by: "writer" } as const,
			"trust.writers is false in the repository's policy",
		],
	] as const)("runs no probe for %s", async (_, config, writer, reason) => {
		const { run } = await review({ planner: plan, prober: [] }, { config, writer });
		expect((await failure(run)).message).toContain(`deep runs probes, which cannot run here: ${reason}`);
	});

	it("probes a writer's head under a policy that trusts writers", async () => {
		const { run } = await review(
			{ planner: plan, prober: probing(failing) },
			{ writer: { trusted: true, by: "writer" } },
		);
		expect((await run).verdict.counted()).toHaveLength(1);
	});

	it("runs no probe where the sandbox cannot run, with the sandbox's reason", async () => {
		const { run } = await review(
			{ planner: plan, prober: [] },
			{ sandbox: { ...unconfinedSandbox(), unavailable: () => "no seatbelt here" } },
		);
		expect((await failure(run)).message).toContain("deep runs probes, which cannot run here: no seatbelt here");
	});

	it("lets triage choose no level that cannot probe, and says so on the record of the level it ran", async () => {
		const decider = new RecordedDecider(
			{ triage: { version: "1", answers: { "trust-boundary": { distribution: { deep: 1 } } } } },
			{ name: "recorded" },
		);
		const careful = "You are the trust-boundary reviewer";
		const { run, requests } = await review(
			{
				planner: [],
				prober: [],
				others: [{ match: careful, replies: [fauxAssistantMessage("Reported 0 findings.")] }],
			},
			{ writer: { trusted: false, detail: "octocat has read permission" }, decider, config: { lenses: {} } },
		);
		const ran = record((await run).verdict);
		expect(ran).toMatchObject({ status: "ran", level: "careful" });
		expect(ran.reason).toContain(
			"triage could not choose deep, since deep runs probes, which cannot run here: octocat has read permission",
		);
		expect(requests[careful]).toHaveLength(1);
		expect(requests[planner]).toEqual([]);
	});

	it("refuses a lens whose prober's tier the plan refuses, before any model is asked", async () => {
		const fake = createFakeModels();
		const { run, requests } = await review(
			{ planner: plan, prober: [] },
			{
				fake,
				lens: probingWith({ prober: "medium" }),
				config: {
					models: {
						heavy: { model: `${fake.ref().provider}/${fake.ref().modelId}` },
						medium: { accept: ["nowhere/model"], unavailable: "fail" },
					},
				},
				plan: async (config, lenses, fake) => {
					const { catalog, credentials } = await planInputs(fake.review);
					return ReviewPlan.resolve({
						config,
						routes: { committed: config.models, overridden: {}, lensTiers: {}, retiered: {} },
						catalog,
						credentials,
						lenses,
						checks: ["lens.trust-boundary"],
					});
				},
			},
		);
		const failed = record((await run).verdict);
		expect(failed).toMatchObject({ status: "failed", level: "deep" });
		expect(failed.reason).toMatch(/^its prober's tier, medium: /);
		expect(requests[planner]).toEqual([]);
	});

	it("unlocks the prober's providers with the planner's, and runs the lens again for another prober", async () => {
		const fake = createFakeModels({ models: [{ id: "planning" }] });
		const other = createFakeModels({ provider: "probing", models: [{ id: "probing" }] }, fake.review);
		const unlocked: string[][] = [];
		const options = {
			fake,
			lens: probingWith({ prober: "light" }),
			config: {
				models: {
					heavy: { model: `${fake.ref("planning").provider}/planning` },
					light: { model: `${other.ref("probing").provider}/probing` },
				},
			},
			unlockModels: async (providers: readonly string[]) => {
				unlocked.push([...providers]);
			},
		};
		const empty = [call("record_plan", { attacks: [] }), plan[1]!];
		const first = await review({ planner: [...empty, ...empty], prober: [] }, options);
		await first.run;
		expect(unlocked.flat()).toContain("probing");
		const again = await review({ planner: [...empty, ...empty], prober: [] }, options);
		await again.run;
		expect(again.requests[planner]).toHaveLength(0);
		const moved = await review(
			{ planner: [...empty, ...empty], prober: [] },
			{ ...options, lens: probingWith({ prober: "light", timeout: 999 }) },
		);
		await moved.run;
		expect(moved.requests[planner]).toHaveLength(2);
	});

	it("names the probing run's providers while it waits on its planner", async () => {
		const fake = createFakeModels({ models: [{ id: "planning" }] });
		const other = createFakeModels({ provider: "probing", models: [{ id: "probing" }] }, fake.review);
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let asked: () => void = () => {};
		const reached = new Promise<void>((resolve) => {
			asked = resolve;
		});
		const { run } = await review(
			{
				planner: [
					async () => {
						asked();
						await held;
						return call("record_plan", { attacks: [] });
					},
					plan[1]!,
				],
				prober: [],
			},
			{
				fake,
				lens: probingWith({ prober: "light" }),
				config: {
					models: {
						heavy: { model: `${fake.ref("planning").provider}/planning` },
						light: { model: `${other.ref("probing").provider}/probing` },
					},
				},
			},
		);
		await reached;
		expect(await harness!.resumedProviders()).toEqual([fake.ref("planning").provider, "probing"]);
		release();
		await run;
	});

	it("refuses each report a role may not make, and an attack or files the plan and the limits do not allow", async () => {
		const injection = {
			...finding("p1"),
			rule: "melian/injection-attempt",
			line: 1,
			evidence: [{ file: "src/load.ts", line: 1, role: "cause" }],
		};
		const { probe: _, ...unprobed } = finding("p1");
		const { run, requests } = await review({
			planner: [
				call("report_finding", unprobed),
				(() => {
					const { probe: __, ...plain } = injection;
					return call("report_finding", plain);
				})(),
				...plan,
			],
			prober: [
				call("report_finding", unprobed),
				call("report_finding", finding("p999")),
				call("record_plan", { attacks: [] }),
				call("run_probe", { attack: 2, script: passing }),
				call("skip_attack", { attack: 2, reason: "none" }),
				call("run_probe", {
					attack: 1,
					script: passing,
					files: [
						{ path: "a", text: "a".repeat(65_536) },
						{ path: "b", text: "b".repeat(65_537) },
					],
				}),
				call("run_probe", {
					attack: 1,
					script:
						'import { readFileSync } from "node:fs";\nconsole.log(readFileSync(new URL("./b", import.meta.url), "utf8").length);\n',
					files: [
						{ path: "a", text: "a".repeat(65_536) },
						{ path: "b", text: "b".repeat(65_536) },
					],
				}),
				fauxAssistantMessage("Reported 0 findings."),
			],
		});
		const { verdict } = await run;
		const planned = requests[planner]!;
		expect(lastResults(planned[1]!)).toContain("the planner writes the attack plan and reports no finding");
		expect(lastResults(planned[2]!)).toContain("recorded finding");
		const probed = requests[prober]!.map(lastResults);
		expect(probed[1]).toContain("a finding of a probing level needs the probe that shows it");
		expect(probed[2]).toContain("no probe p999 ran in this conversation");
		expect(probed[3]).toContain("Tool record_plan is not");
		expect(probed[4]).toContain("attack 2 is not in the plan, which has 1");
		expect(probed[5]).toContain("attack 2 is not in the plan, which has 1");
		expect(probed[6]).toContain("a probe's files hold at most 131072 bytes; these hold 131073");
		expect(probed[7]).toMatch(/probe p[0-9]+ passed: it exited 0, so the boundary held/);
		expect(probed[7]).toContain("65536");
		expect(verdict.counted().map((each) => each.ruleId)).toEqual(["melian/injection-attempt"]);
	});

	it("refuses a probe from a lens at a level that does not probe", async () => {
		const careful = "You are the trust-boundary reviewer";
		const { run, requests } = await review(
			{
				planner: [],
				prober: [],
				others: [
					{ match: careful, replies: [call("report_finding", finding("p1")), fauxAssistantMessage("Done.")] },
				],
			},
			{ config: { lenses: {} } },
		);
		await run;
		expect(lastResults(requests[careful]![1]!)).toContain("probe is only for the prober of a level that runs probes");
	});

	it("ends a prober whose probes spend the tools budget, as reads do", async () => {
		const { run, requests } = await review(
			{
				planner: plan,
				prober: [
					fauxAssistantMessage(
						[1, 2, 3].map(() => fauxToolCall("run_probe", { attack: 1, script: passing })),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Done."),
				],
			},
			{ lens: probingWith({}, { tools: 2 }) },
		);
		const ended = record((await run).verdict);
		expect(lastResults(requests[prober]![1]!)).toContain("[not run: this lens may make 2 tool calls");
		expect(ended).toMatchObject({ status: "ended", budgetEnded: { budget: "tools", limit: 2 } });
	});

	it("caps a prober that reports past the findings budget", async () => {
		let probe = "p0";
		const { run, requests } = await review(
			{
				planner: plan,
				prober: [
					call("run_probe", { attack: 1, script: failing }),
					(messages) => {
						probe = /probe (p[0-9]+)/.exec(lastResults(messages))?.[1] ?? "p0";
						return call("report_finding", finding(probe));
					},
					() =>
						call("report_finding", {
							...finding(probe),
							line: 2,
							evidence: [{ file: "src/load.ts", line: 2, role: "cause" }],
						}),
					fauxAssistantMessage("Reported 1 finding."),
				],
			},
			{ lens: probingWith({}, { findings: 1 }) },
		);
		const ended = record((await run).verdict);
		expect(lastResults(requests[prober]![3]!)).toContain("budget reached: this lens may report 1 findings");
		expect(ended.status).toBe("ended");
		expect(ended.reason).toContain("its findings budget of 1 ran out");
	});

	it("plans from the base's decisions and the findings of the change's earlier revision", async () => {
		// One harness for both pushes, on one fake.
		const fake = createFakeModels();
		const first = await review({ planner: plan, prober: probing(failing) }, { fake });
		await first.run;
		writeFiles(repo, { "src/other.ts": "export const other = 1;\n" });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "second push");
		const second = await review({ planner: [call("record_plan", { attacks: [] }), plan[1]!], prober: [] }, { fake });
		await second.run;
		const prompt = systemPromptOf(second.requests[planner]![0]!);
		expect(prompt).toContain("## Findings earlier reviews reported");
		expect(prompt).toContain("P1 path-traversal at src/load.ts:3, new: load reads any path");
		expect(prompt).toContain("## Decisions at base");
		expect(prompt).toContain("Paths stay inside");
		expect(systemPromptOf(first.requests[planner]![0]!)).toContain(
			"No earlier review of this change reported a finding.",
		);
	});

	it("shows each conversation's role and the prober's probes in the stage telemetry", async () => {
		const { run, changeset } = await review({ planner: plan, prober: probing(failing) });
		await run;
		const telemetry = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		const lenses = telemetry.stages.filter((stage) => stage.name === "melian.lens");
		expect(lenses.map((stage) => stage.role)).toEqual(["planner", "prober"]);
		expect(lenses[0]!.probes).toBeUndefined();
		expect(lenses[1]!.probes).toMatchObject({ count: 1, limit: 30_000 });
		expect(telemetry.render()).toMatch(/ prober probes=1 probeTime=[0-9]+ms probeLimit=30000ms/);
		expect(telemetry.runDetails().stages.map((stage) => stage.name)).toEqual(
			expect.arrayContaining(["lens trust-boundary planner", "lens trust-boundary prober"]),
		);
	});
});
