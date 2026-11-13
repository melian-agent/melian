import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	backgroundContext,
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
	scriptVerifier,
	systemPromptOf,
	textOf,
	unconfinedSandbox,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { TaskId } from "../src/harness.ts";
import { type ReviewState, recordPlan, skipAttack } from "../src/lens-tools.ts";
import { planInputs } from "../src/models.ts";
import { headTreeLimits, ProbeReruns, probingLimits } from "../src/probing.ts";
import { createReviewRegistry, probeRerunTask } from "../src/review.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { baseAndHead, gitIn, writeFiles } from "./fixtures/repo.ts";

// A level that probes, end to end on the fake model: the planner records the plan, the prober runs probes under a
// sandbox that runs them unconfined, since every probe here is the test's own, and the verifier judges what they show.

let repo: string;
let harness: ReviewHarness | undefined;
let storage: Storage;

const baseFiles = {
	"src/load.ts": "export function load(path: string) {\n\treturn path;\n}\n",
	"docs/decisions/2026-01-01-paths-stay-inside.md":
		"# Paths stay inside\n\nStatus: accepted.\n\nA path an author names stays inside the repository.\n",
};
const headFiles = {
	"src/load.ts":
		'import { readFileSync } from "node:fs";\nexport function load(path: string) {\n\treturn readFileSync(path, "utf8");\n}\n',
	"fixture/leak.txt": "LEAK\n",
};

beforeEach(() => {
	repo = baseAndHead(baseFiles, headFiles);
});

// The repository again, with `policy` as the base's melian.yaml, which a probe's allowlist and writer trust come from.
function withBasePolicy(policy: string) {
	rmSync(repo, { recursive: true, force: true });
	repo = baseAndHead({ ...baseFiles, "melian.yaml": policy }, headFiles);
}

afterEach(async () => {
	await harness?.close();
	harness = undefined;
	rmSync(repo, { recursive: true, force: true });
});

// Whether a probe is running in a tree of the head, asked while it runs: Probe starts every probe in its tree, and only
// the head's holds files, the empty probe's that checks the sandbox none.
function inHeadTree(command: string): boolean {
	const tree = /^cd '([^']+\/tree)'/.exec(command)?.[1];
	return tree !== undefined && readdirSync(tree).length > 0;
}

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

// The text of each tool result answering the request's last assistant turn, in call order.
function resultsOf(messages: Parameters<Extract<ScriptedReply, (...args: never[]) => unknown>>[0]): string[] {
	const last = messages.findLastIndex((message) => message.role === "assistant");
	return messages
		.slice(last + 1)
		.filter((message) => message.role === "toolResult")
		.map(textOf);
}

// One model turn making every call in `calls`, in one round.
function round(calls: readonly (readonly [string, Record<string, unknown>])[]) {
	return fauxAssistantMessage(
		calls.map(([name, args]) => fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])),
		{ stopReason: "toolUse" },
	);
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
		// Rewrites the trust-boundary lens; by default its deep level probes, as no shipped level does yet.
		lens?: (lens: Lens) => Lens;
		// Adds lenses to the ones loaded.
		lenses?: (loaded: readonly Lens[]) => Lens[];
		fake?: FakeModels;
		decider?: ReviewOptions["decider"];
		plan?: (config: MelianConfig, lenses: readonly Lens[], fake: FakeModels) => Promise<ReviewOptions["plan"]>;
		unlockModels?: ReviewOptions["unlockModels"];
		rerun?: boolean;
		policy?: ReviewOptions["policy"];
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
	// Other conversations first, so another lens's planner, whose prompt also names the planner's role, finds its own.
	const requests = scriptConversations(fake, [
		...(scripts.others ?? []),
		{ match: planner, replies: scripts.planner },
		{ match: prober, replies: scripts.prober },
	]);
	// The head probes as they run, since a tree is gone once its probe ends.
	const heads: string[] = [];
	const sandbox = unconfinedSandbox((command) => {
		if (inHeadTree(command)) heads.push(command);
		return options.rewrite?.(command) ?? command;
	});
	storage = harness === undefined ? createMemoryStorage() : storage;
	harness ??= await openReviewHarness(storage, fake.review, {
		retry: false,
		probeSandbox: options.sandbox ?? sandbox,
		...(options.decider === undefined ? {} : { decider: options.decider }),
	});
	const lenses = (await Lens.load(repo, policy, paths)).map((lens) =>
		lens.name === "trust-boundary" ? (options.lens ?? probingWith({}))(lens) : lens,
	);
	if (options.lenses !== undefined) lenses.push(...options.lenses(lenses));
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
		...(options.rerun === undefined ? {} : { rerun: options.rerun }),
		...(options.policy === undefined ? {} : { policy: options.policy }),
	});
	return { run, requests, sandbox, heads, changeset };
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

// The lens's own instructions, as a level runs them without probes.
const reviewer = "You are the trust-boundary reviewer";

// A review in which the deep level runs as it would without `probe`, answering once.
function withoutProbes(options: Parameters<typeof review>[1]) {
	return review(
		{
			planner: [],
			prober: [],
			others: [{ match: reviewer, replies: [fauxAssistantMessage("Reported 0 findings.")] }],
		},
		options,
	);
}

describe("a level that probes", () => {
	it("reports a finding only with a probe that failed, and the verifier judges the probe it ran again", async () => {
		const { run, requests, heads } = await review({ planner: plan, prober: probing(failing) });
		const { verdict } = await run;
		const found = verdict.counted();
		expect(found.map((each) => [each.properties.path, each.ruleId, each.properties.verification?.verdict])).toEqual([
			["src/load.ts", "path-traversal", "confirmed"],
		]);
		// The prober's probe and the verifier's rerun; the empty probe that says probes run here holds no head.
		expect(heads).toHaveLength(2);
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
		// No quick run carried a finding, so the prober's input lists none.
		expect(input).not.toMatch(/\bundefined\b|Findings a quicker look reported/);
		expect(systemPromptOf(probed)).not.toContain("You are the trust-boundary reviewer");
		const record = verdict.ran!.find(({ name }) => name === "lens.trust-boundary")!;
		expect(record).toMatchObject({ status: "ran", level: "deep" });
		expect(record.reason).toMatch(/it planned 1 attack and ran 1 probe in (?:[0-9]+\.[0-9]|under 0\.1) s/);
		// The planner records, then answers; the prober probes, reports and answers, with no reminder to either.
		expect(requests[planner]).toHaveLength(2);
		expect(lastResults(requests[planner]![1]!)).toMatch(/recorded a plan of 1 attack\b/);
		expect(requests[prober]).toHaveLength(3);
		expect(lastResults(requests[prober]![1]!)).toMatch(/probe p[0-9]+ failed: it exited 1, so it shows the defect/);
		expect(lastResults(requests[prober]![1]!)).toContain(`<untrusted-`);
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
			{ rewrite: (command) => (inHeadTree(command) && ++heads > 1 ? "exit 0" : command) },
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
		expect(lastResults(requests[planner]![1]!)).toContain("recorded a plan of 2 attacks");
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

	it("counts only the skipped attacks no probe answered, beside another the prober probed", async () => {
		const { run } = await review({
			planner: [call("record_plan", { attacks: [attack, attack] }), plan[1]!],
			prober: [
				call("skip_attack", { attack: 1, reason: "it needs the network" }),
				call("run_probe", { attack: 2, script: passing }),
				fauxAssistantMessage("Done."),
			],
		});
		const { reason } = record((await run).verdict);
		expect(reason).toMatch(/it planned 2 attacks and ran 1 probe in .+ s, and skipped 1 attack/);
	});

	it("runs a round's probes one at a time, so each writes its head's tree alone", async () => {
		// Each probe logs when it starts, and takes long enough that two at once would start together. Its command ends in
		// exec, so nothing after it runs.
		const log = join(mkdtempSync(join(tmpdir(), "melian-probe-order-")), "log");
		const slow = "await new Promise((resolve) => setTimeout(resolve, 500));\nprocess.exit(0);\n";
		try {
			const { run } = await review(
				{
					planner: [call("record_plan", { attacks: [attack, attack] }), plan[1]!],
					prober: [
						round([
							["run_probe", { attack: 1, script: slow }],
							["run_probe", { attack: 2, script: slow }],
						]),
						fauxAssistantMessage("Done."),
					],
				},
				{
					rewrite: (command) => (inHeadTree(command) ? `date +%s%3N >> '${log}'; ${command}` : command),
				},
			);
			await run;
			const [first, second] = readFileSync(log, "utf8").trim().split("\n").map(Number);
			expect(second! - first!).toBeGreaterThanOrEqual(500);
		} finally {
			rmSync(join(log, ".."), { recursive: true, force: true });
		}
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

	it("runs a level that cannot probe here without probes, as it ran before, and says why", async () => {
		const { run, requests } = await withoutProbes({
			writer: { trusted: false, detail: "octocat has read permission" },
		});
		const ran = record((await run).verdict);
		expect(ran).toMatchObject({ status: "ran", level: "deep" });
		expect(ran.reason).toContain("deep ran without probes, which cannot run here: octocat has read permission");
		expect(requests[reviewer]).toHaveLength(1);
		expect(systemPromptOf(requests[reviewer]![0]!)).not.toContain(planner);
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
		const { run, requests, changeset } = await review(
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
		// The prober's time limit reaches the telemetry; the verifier's stage carries no role.
		const telemetry = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		const roles = telemetry.stages.filter((stage) => stage.name === "melian.lens").map((stage) => stage.role);
		expect(roles).toEqual(["planner", "prober"]);
		expect(telemetry.stages.find((stage) => stage.role === "prober")!.probes).toMatchObject({ count: 1, limit: 300 });
	});

	it("runs a prober on its level's tier on the lens's own route, as its planner runs", async () => {
		const fake = createFakeModels({ models: [{ id: "tiered" }, { id: "routed" }] });
		const seen: string[] = [];
		const on =
			(role: string, reply: ScriptedReply): ScriptedReply =>
			(messages, model) => {
				seen.push(`${role} ${model}`);
				return typeof reply === "function" ? reply(messages, model) : reply;
			};
		const { run } = await review(
			{
				planner: plan.map((reply) => on("planner", reply)),
				prober: [on("prober", fauxAssistantMessage("Reported 0 findings."))],
			},
			{
				fake,
				config: {
					models: { heavy: { model: `${fake.ref("tiered").provider}/tiered` } },
					lenses: {
						"trust-boundary": {
							level: { floor: "deep" },
							route: { model: `${fake.ref("routed").provider}/routed` },
						},
					},
				},
			},
		);
		await run;
		expect([...new Set(seen)]).toEqual(["planner routed", "prober routed"]);
	});

	it("runs without probes when its prober's tier reaches no model, naming the tier", async () => {
		const { run } = await withoutProbes({ lens: probingWith({ prober: "light" }) });
		expect(record((await run).verdict).reason).toContain(
			"deep ran without probes, since its prober runs on light, and",
		);
	});

	it.each([
		["no writer", undefined, undefined, "the host did not say whose head this is"],
		[
			"a writer under a base policy that trusts no writer",
			"trust:\n  writers: false\n",
			{ trusted: true, by: "writer" } as const,
			"trust.writers is false in the repository's policy",
		],
	] as const)("runs no probe for %s", async (_, policy, writer, reason) => {
		if (policy !== undefined) withBasePolicy(policy);
		const { run } = await withoutProbes({ writer });
		expect(record((await run).verdict).reason).toContain(`deep ran without probes, which cannot run here: ${reason}`);
	});

	it("reads probe trust from the policy revision the host names, not the merge base, once the base branch moves", async () => {
		// The base branch moves past the merge base and stops trusting writers; the host names its new tip as the policy.
		gitIn(repo, "checkout", "main");
		writeFiles(repo, {
			"melian.yaml":
				"tiers:\n  full: [lens.trust-boundary]\nlenses:\n  trust-boundary:\n    level: { floor: deep }\ntrust:\n  writers: false\n",
		});
		gitIn(repo, "add", "-A");
		gitIn(repo, "commit", "-m", "trust no writer");
		const tip = gitIn(repo, "rev-parse", "HEAD");
		gitIn(repo, "checkout", "feature");
		const { run } = await withoutProbes({
			writer: { trusted: true, by: "writer" },
			policy: { kind: "revision", commit: tip },
		});
		expect(record((await run).verdict).reason).toContain(
			"deep ran without probes, which cannot run here: trust.writers is false in the repository's policy",
		);
	});

	it("probes a writer's head under a policy that trusts writers", async () => {
		const { run } = await review(
			{ planner: plan, prober: probing(failing) },
			{ writer: { trusted: true, by: "writer" } },
		);
		expect((await run).verdict.counted()).toHaveLength(1);
	});

	it("runs a level without probes when the head itself refuses them, as one past its tree limits does", async () => {
		const limits = headTreeLimits as { entries: number };
		const entries = limits.entries;
		limits.entries = 1;
		onTestFinished(() => {
			limits.entries = entries;
		});
		const { run } = await withoutProbes({});
		expect(record((await run).verdict).reason).toContain(
			"deep ran without probes, which cannot run here: the head refuses probes: the head holds more than 1 entries",
		);
	});

	it("runs a level without probes when the base policy's probe.read leads out of the checkout", async () => {
		withBasePolicy("probe:\n  read: [outside]\n");
		symlinkSync(tmpdir(), join(repo, "outside"));
		const { run } = await withoutProbes({});
		expect(record((await run).verdict).reason).toContain(
			"deep ran without probes, which cannot run here: the head refuses probes: probe.read may name only a relative path inside the checkout, not outside",
		);
	});

	it("counts every entry of the head's tree toward its limit, a gitlink as well as a file", async () => {
		// Two gitlinks beside the head's three files: within a limit of four files, past one of four entries.
		const commit = gitIn(repo, "rev-parse", "HEAD");
		for (const path of ["vendor/a", "vendor/b"])
			gitIn(repo, "update-index", "--add", "--cacheinfo", `160000,${commit},${path}`);
		gitIn(repo, "commit", "-m", "two gitlinks");
		const limits = headTreeLimits as { entries: number };
		const entries = limits.entries;
		limits.entries = 4;
		onTestFinished(() => {
			limits.entries = entries;
		});
		const { run } = await withoutProbes({});
		expect(record((await run).verdict).reason).toContain(
			"deep ran without probes, which cannot run here: the head refuses probes: the head holds more than 4 entries",
		);
	});

	it("runs no probe where the sandbox cannot run, with the sandbox's reason", async () => {
		const { run } = await withoutProbes({
			sandbox: { ...unconfinedSandbox(), unavailable: () => "no seatbelt here" },
		});
		expect(record((await run).verdict).reason).toContain(
			"deep ran without probes, which cannot run here: no seatbelt here",
		);
	});

	it("lets triage choose a level that cannot probe here, which runs without probes", async () => {
		const decider = new RecordedDecider(
			{ triage: { version: "1", answers: { "trust-boundary": { distribution: { deep: 1 } } } } },
			{ name: "recorded" },
		);
		const { run, requests } = await withoutProbes({
			writer: { trusted: false, detail: "octocat has read permission" },
			decider,
			config: { lenses: {} },
		});
		const ran = record((await run).verdict);
		expect(ran).toMatchObject({ status: "ran", level: "deep" });
		expect(ran.reason).toContain("deep ran without probes, which cannot run here: octocat has read permission");
		expect(requests[reviewer]).toHaveLength(1);
	});

	it("runs without probes when the plan refuses its prober's tier, and asks it nothing there", async () => {
		const fake = createFakeModels();
		const { run, requests } = await withoutProbes({
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
		});
		const ran = record((await run).verdict);
		expect(ran).toMatchObject({ status: "ran", level: "deep" });
		expect(ran.reason).toMatch(/deep ran without probes, since the plan refuses its prober's tier, medium: /);
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
		// Another time limit, and another thinking level for the prober's tier, each run the lens again.
		const longer = await review(
			{ planner: [...empty, ...empty], prober: [] },
			{ ...options, lens: probingWith({ prober: "light", timeout: 1000 }) },
		);
		await longer.run;
		expect(longer.requests[planner]).toHaveLength(2);
		const thought = await review(
			{ planner: [...empty, ...empty], prober: [] },
			{
				...options,
				lens: probingWith({ prober: "light", timeout: 1000 }),
				config: {
					models: { ...options.config.models, light: { ...options.config.models.light, thinking: "low" } },
				},
			},
		);
		await thought.run;
		expect(thought.requests[planner]).toHaveLength(2);
		// A head another writer vouches for runs the lens again, since the prober's trust is part of its selection.
		const vouched = await review(
			{ planner: [...empty, ...empty], prober: [] },
			{
				...options,
				lens: probingWith({ prober: "light", timeout: 1000 }),
				config: {
					models: { ...options.config.models, light: { ...options.config.models.light, thinking: "low" } },
				},
				writer: { trusted: true, by: "writer" },
			},
		);
		await vouched.run;
		expect(vouched.requests[planner]).toHaveLength(2);
	}, 60_000);

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

	it("runs a claim's probe again once, and a repeat review reads the stored run", async () => {
		const fake = createFakeModels();
		const first = await review({ planner: plan, prober: probing(failing) }, { fake });
		await first.run;
		const heads = () => first.heads.length;
		expect(heads()).toBe(2);
		const again = await review({ planner: [], prober: [] }, { fake });
		expect((await again.run).verdict.counted()).toHaveLength(1);
		expect(heads()).toBe(2);
	});

	it("runs a probe again once however many findings cite it", async () => {
		let id = "p0";
		const { run, heads } = await review({
			planner: plan,
			prober: [
				call("run_probe", { attack: 1, script: failing }),
				(messages) => {
					id = /probe (p[0-9]+)/.exec(lastResults(messages))?.[1] ?? id;
					return call("report_finding", finding(id));
				},
				() =>
					call("report_finding", {
						...finding(id),
						line: 2,
						rule: "head-controls-judge",
						evidence: [{ file: "src/load.ts", line: 2, role: "cause" }],
					}),
				fauxAssistantMessage("Reported 2 findings."),
			],
		});
		const result = await run;
		expect(result.verdict.counted()).toHaveLength(2);
		// The prober's probe and one rerun the two claims share.
		expect(heads).toHaveLength(2);
	});

	it("runs a probe again once in a review though its rerun shows nothing and two findings cite it", async () => {
		let id = "p0";
		let heads = 0;
		const { run } = await review(
			{
				planner: plan,
				prober: [
					call("run_probe", { attack: 1, script: failing }),
					(messages) => {
						id = /probe (p[0-9]+)/.exec(lastResults(messages))?.[1] ?? id;
						return call("report_finding", finding(id));
					},
					() =>
						call("report_finding", {
							...finding(id),
							line: 2,
							rule: "head-controls-judge",
							evidence: [{ file: "src/load.ts", line: 2, role: "cause" }],
						}),
					fauxAssistantMessage("Reported 2 findings."),
				],
			},
			{
				lens: probingWith({ timeout: 2_000 }),
				rewrite: (command) => (inHeadTree(command) && ++heads > 1 ? "sleep 10" : command),
			},
		);
		await run.catch(() => undefined);
		// The prober's probe and one rerun, which timed out, for both claims.
		expect(heads).toBe(2);
	});

	it("runs a probe again once when two reviews of one head verify at once", async () => {
		const fake = createFakeModels();
		const first = await review({ planner: plan, prober: probing(failing) }, { fake });
		const second = await review({ planner: plan, prober: probing(failing) }, { fake });
		await Promise.all([first.run, second.run].map((run) => run.catch(() => undefined)));
		// The prober's probe and one rerun, which the second review attached to.
		expect(first.heads).toHaveLength(2);
	});

	it.each([
		["runs no probe once another review has taken the revision", [failing, failing], 0],
		["prunes nothing when every probe it holds already stands", [], 0],
	])("writes nothing from a rerun task another review took the revision from: %s", async (_, scripts, ran) => {
		const { run, changeset, heads } = await review({ planner: plan, prober: probing(failing) });
		await run;
		const reviewer = harness!.harness;
		const root = await reviewer.root(backgroundContext);
		const at = Revision.key(changeset.revision);
		const index = (await reviewer.snapshot(ReviewIndex, root.id, backgroundContext))!.reviews[at]!;
		const lensTask = await reviewer.getTask(index.task as TaskId, backgroundContext);
		const { revision } = lensTask!.input as unknown as { revision: ReviewState };
		const before = (await reviewer.snapshot(ProbeReruns, root.id, backgroundContext))!.runs[at]!;
		const standing = Object.keys(before);
		const environment = { writer: { trusted: true, by: "reviewer" } as const, trustWriters: true, read: [] };
		// New probes it would run, or only the probe whose rerun already stands, which leaves the prune alone to decide.
		const probes =
			scripts.length === 0
				? [{ key: standing[0]!, script: failing, files: [], environment }]
				: scripts.map((script, n) => ({ key: `replaced ${n}`, script, files: [], environment }));
		const task = await root.commit(async (tx) => {
			const document = await tx.doc(ProbeReruns, root.id);
			document.tasks = { ...document.tasks, [at]: { task: -1, key: "another review's probes" } };
			document.runs = {
				...document.runs,
				[at]: { ...document.runs[at], "another review's": before[standing[0]!]! },
			};
			return tx.createTask(
				probeRerunTask(),
				{ root: root.id, revision, probes },
				{ ownership: { kind: "conversation" } },
			);
		}, backgroundContext);
		const headsBefore = heads.length;
		await reviewer.waitForTask(task, backgroundContext);
		// It ends as it would have finished, so nothing reads its stop as a failure.
		expect((await reviewer.getTask(task, backgroundContext))!.state).toMatchObject({
			status: "terminal",
			outcome: { status: "completed" },
		});
		const runs = (await reviewer.snapshot(ProbeReruns, root.id, backgroundContext))!.runs[at]!;
		expect(Object.keys(runs).sort()).toEqual([...standing, "another review's"].sort());
		expect(heads.length - headsBefore).toBe(ran);
	});

	it("writes no rerun from a task another review takes the revision from while its probe runs", async () => {
		let during: (() => void) | undefined;
		const { run, changeset } = await review(
			{ planner: plan, prober: probing(failing) },
			{
				rewrite: (command) => {
					if (inHeadTree(command)) during?.();
					return command;
				},
			},
		);
		await run;
		const reviewer = harness!.harness;
		const root = await reviewer.root(backgroundContext);
		const at = Revision.key(changeset.revision);
		const index = (await reviewer.snapshot(ReviewIndex, root.id, backgroundContext))!.reviews[at]!;
		const lensTask = await reviewer.getTask(index.task as TaskId, backgroundContext);
		const { revision } = lensTask!.input as unknown as { revision: ReviewState };
		const standing = Object.keys((await reviewer.snapshot(ProbeReruns, root.id, backgroundContext))!.runs[at]!);
		const environment = { writer: { trusted: true, by: "reviewer" } as const, trustWriters: true, read: [] };
		let taken: Promise<void> | undefined;
		during = () => {
			taken = root.commit(async (tx) => {
				(await tx.doc(ProbeReruns, root.id)).tasks![at] = { task: -1, key: "another review's probes" };
			}, backgroundContext);
		};
		const task = await root.commit(async (tx) => {
			const created = await tx.createTask(
				probeRerunTask(),
				{ root: root.id, revision, probes: [{ key: "taken", script: failing, files: [], environment }] },
				{ ownership: { kind: "conversation" } },
			);
			const document = await tx.doc(ProbeReruns, root.id);
			document.tasks = { ...document.tasks, [at]: { task: created, key: "this task's probes" } };
			return created;
		}, backgroundContext);
		await reviewer.waitForTask(task, backgroundContext);
		await taken;
		expect(taken).toBeDefined();
		const runs = (await reviewer.snapshot(ProbeReruns, root.id, backgroundContext))!.runs[at]!;
		expect(Object.keys(runs)).toEqual(standing);
	});

	it("starts no rerun for a review whose lens task another review has replaced", async () => {
		const fake = createFakeModels();
		// The prober's last turn stands for the moment another review replaces this one's lens task in the index.
		const replaced: ScriptedReply = async () => {
			const root = await harness!.harness.root(backgroundContext);
			await root.commit(async (tx) => {
				const index = await tx.doc(ReviewIndex, root.id);
				for (const key of Object.keys(index.reviews)) index.reviews[key] = { ...index.reviews[key]!, task: -1 };
			}, backgroundContext);
			return fauxAssistantMessage("Reported 1 finding.");
		};
		const prober = probing(failing);
		const { run, heads } = await review({ planner: plan, prober: [...prober.slice(0, -1), replaced] }, { fake });
		// The replaced review may fail as replaced, but never on a reruns document it never wrote.
		const outcome = await run.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(outcome).not.toBeInstanceOf(TypeError);
		// The prober's probe alone: the replaced review runs no probe again.
		expect(heads).toHaveLength(1);
	});

	it("stores no rerun the sandbox refused, so a repeat review runs the probe again", async () => {
		const fake = createFakeModels();
		let heads = 0;
		const base = unconfinedSandbox();
		const sandbox: ProbeSandbox = {
			...base,
			wrap: async (command, policy) => {
				if (inHeadTree(command) && ++heads === 2) throw new Error("the sandbox hiccuped");
				return base.wrap(command, policy);
			},
		};
		const first = await review({ planner: plan, prober: probing(failing) }, { fake, sandbox });
		expect((await failure(first.run)).code).toBe("verifierFailed");
		const again = await review({ planner: [], prober: [] }, { fake });
		await again.run.catch(() => undefined);
		const root = (await harness!.harness.root(backgroundContext)).id;
		const runs = Object.values(
			(await harness!.harness.snapshot(ProbeReruns, root, backgroundContext))!.runs[
				Revision.key(again.changeset.revision)
			]!,
		);
		expect(heads).toBe(3);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toHaveProperty("result");
	});

	it("runs a probe again on a repeat review when its stored rerun timed out", async () => {
		const fake = createFakeModels();
		let heads = 0;
		const lens = probingWith({ timeout: 2_000 });
		const first = await review(
			{ planner: plan, prober: probing(failing) },
			{ fake, lens, rewrite: (command) => (inHeadTree(command) && ++heads === 2 ? "sleep 10" : command) },
		);
		// The scripted verifier confirms, which a rerun that showed nothing refuses.
		expect((await failure(first.run)).code).toBe("verifierFailed");
		expect(first.heads).toHaveLength(2);
		const again = await review({ planner: [], prober: [] }, { fake, lens });
		const found = (await again.run).verdict.counted();
		expect(first.heads).toHaveLength(3);
		expect(found.map((each) => each.properties.verification?.verdict)).toEqual(["confirmed"]);
	});

	it("judges a claim again once a refused rerun runs, so the verifier reads the run that reproduced it", async () => {
		const fake = createFakeModels();
		let heads = 0;
		const base = unconfinedSandbox();
		const sandbox: ProbeSandbox = {
			...base,
			wrap: async (command, policy) => {
				if (inHeadTree(command) && ++heads === 2) throw new Error("the sandbox hiccuped");
				return base.wrap(command, policy);
			},
		};
		const judge: ScriptedReply = (messages) => {
			if (messages.some((message) => message.role === "toolResult")) return fauxAssistantMessage("Judged.");
			const prompt = systemPromptOf(messages);
			const reproduced = prompt.includes("When Melian ran it again it failed");
			return call("report_verdict", {
				claim: /Claim (c[0-9]+) finding/.exec(prompt)![1]!,
				answers: { code: "yes", guard: "no", base: "no" },
				verdict: reproduced ? "confirmed" : "plausible",
				reason: reproduced ? "The probe failed again." : "Melian could not run the probe again.",
			});
		};
		const verifier = { match: "Melian adversarial verifier", replies: [judge, judge] };
		const first = await review({ planner: plan, prober: probing(failing), others: [verifier] }, { fake, sandbox });
		const verified = (verdict: Awaited<typeof first.run>["verdict"]) =>
			verdict.counted().map((each) => each.properties.verification?.verdict);
		expect(verified((await first.run).verdict)).toEqual(["plausible"]);
		const again = await review({ planner: [], prober: [], others: [verifier] }, { fake });
		expect(verified((await again.run).verdict)).toEqual(["confirmed"]);
		expect(heads).toBe(3);
	});

	it("keeps the later of two plans recorded in one turn, so the prober answers the plan the planner meant", async () => {
		const second = { ...attack, target: "src/load.ts loadAll()" };
		const { run, requests } = await review({
			planner: [
				round([
					["record_plan", { attacks: [attack] }],
					["record_plan", { attacks: [attack, second] }],
				]),
				fauxAssistantMessage("Planned 2 attacks."),
			],
			prober: [
				call("skip_attack", { attack: 1, reason: "r" }),
				call("skip_attack", { attack: 2, reason: "r" }),
				fauxAssistantMessage("Done."),
			],
		});
		await run;
		const plan = requests[prober]![0]!.filter((message) => message.role === "user")
			.map(textOf)
			.join("\n");
		expect(plan).toContain("2 attacks");
		expect(plan).toContain("src/load.ts loadAll()");
		// In process the later call commits last either way; the order holds on a replay only because Pi runs them in turn.
		expect(recordPlan.executionMode).toBe("sequential");
	});

	it("gives the verifier the probe of a finding whose prober failed after reporting it", async () => {
		const reported = probing(failing).slice(0, 2);
		const { run, requests } = await review({ planner: plan, prober: reported });
		expect((await failure(run)).code).toBe("lensFailed");
		const judged = systemPromptOf(requests["Melian adversarial verifier"]![0]!);
		expect(judged).toContain("Claim c1 rests on probe p");
	});

	it("counts a skipped attack the prober went on to probe as probed", async () => {
		const { run } = await review({
			planner: plan,
			prober: [
				call("skip_attack", { attack: 1, reason: "it needs the network" }),
				call("run_probe", { attack: 1, script: passing }),
				fauxAssistantMessage("Done."),
			],
		});
		const note = record((await run).verdict).reason!;
		expect(note).toContain("it planned 1 attack and ran 1 probe in");
		expect(note).not.toContain("skipped");
	});

	it("records a prober's injection attempt without a probe", async () => {
		const injection = {
			file: "src/load.ts",
			line: 1,
			rule: "melian/injection-attempt",
			severity: "P1",
			explanation: { what: "w", why: "y", fix: "f" },
			failureScenario: "The head tells the reviewer to approve the change.",
			evidence: [{ file: "src/load.ts", line: 1, role: "cause" }],
		};
		const { run, requests } = await review({
			planner: plan,
			prober: [
				call("skip_attack", { attack: 1, reason: "r" }),
				call("report_finding", injection),
				fauxAssistantMessage("Done."),
			],
		});
		expect((await run).verdict.counted().map((each) => each.ruleId)).toEqual(["melian/injection-attempt"]);
		expect(lastResults(requests[prober]![2]!)).toContain("recorded finding");
	});

	it("lets a verifier answer plausible for a claim whose probe passed again, though not confirm it", async () => {
		let heads = 0;
		const plausible: ScriptedReply = (messages) => {
			if (messages.some((message) => message.role === "toolResult")) return fauxAssistantMessage("Judged.");
			const claim = /Claim (c[0-9]+) finding/.exec(systemPromptOf(messages))![1]!;
			return call("report_verdict", {
				claim,
				answers: { code: "yes", guard: "no", base: "no" },
				verdict: "plausible",
				reason: "The probe passed again, but the read is unconfined.",
			});
		};
		const { run, requests } = await review(
			{
				planner: plan,
				prober: probing(failing),
				others: [{ match: "Melian adversarial verifier", replies: [plausible, plausible] }],
			},
			{ rewrite: (command) => (inHeadTree(command) && ++heads > 1 ? "exit 0" : command) },
		);
		const { verdict } = await run;
		expect(verdict.counted().map((each) => each.properties.verification?.verdict)).toEqual(["plausible"]);
		expect(lastResults(requests["Melian adversarial verifier"]![1]!)).toContain("recorded verdict for c1");
	});

	it("holds the plan, a skip and a probe to their bounds, and takes each at its bound", async () => {
		const long = (count: number) => "x".repeat(count);
		const at = { target: long(300), reason: long(1000), passing: long(600), failing: long(600) };
		const padded = (bytes: number) => `process.exit(0);\n//${"x".repeat(bytes - 19)}`;
		const { run, requests } = await review(
			{
				planner: [
					round([
						["record_plan", { attacks: Array.from({ length: 25 }, () => attack) }],
						["record_plan", { attacks: [{ ...at, target: long(301) }] }],
						["record_plan", { attacks: [{ ...at, reason: long(1001) }] }],
						["record_plan", { attacks: [{ ...at, passing: long(601) }] }],
						["record_plan", { attacks: [{ ...at, failing: long(601) }] }],
						["record_plan", { attacks: [{ ...at, target: " " }] }],
						["record_plan", { attacks: [{ ...at, extra: "x" }] }],
						["record_plan", { attacks: [at], extra: "x" }],
					]),
					call("record_plan", { attacks: Array.from({ length: 24 }, () => at) }),
					fauxAssistantMessage("Planned 24 attacks."),
				],
				prober: [
					round([
						["skip_attack", { attack: 0, reason: "r" }],
						["skip_attack", { attack: 1, reason: long(1001) }],
						["skip_attack", { attack: 1, reason: "r", extra: "x" }],
						["run_probe", { attack: 0, script: passing }],
						["run_probe", { attack: 1, script: padded(32_769) }],
						[
							"run_probe",
							{
								attack: 1,
								script: passing,
								files: Array.from({ length: 17 }, (_, index) => ({ path: `f${index}`, text: "" })),
							},
						],
						["run_probe", { attack: 1, script: passing, files: [{ path: "a", text: "", extra: "x" }] }],
						["run_probe", { attack: 1, script: passing, extra: "x" }],
					]),
					round([
						[
							"run_probe",
							{
								attack: 1,
								script: padded(32_768),
								files: Array.from({ length: 16 }, (_, index) => ({ path: `f${index}`, text: "" })),
							},
						],
						...Array.from(
							{ length: 24 },
							(_, index) => ["skip_attack", { attack: index + 1, reason: long(1000) }] as const,
						),
					]),
					fauxAssistantMessage("Done."),
				],
			},
			{ lens: probingWith({}, { tools: 60 }) },
		);
		const ran = record((await run).verdict);
		const planned = resultsOf(requests[planner]![1]!);
		expect(planned).toHaveLength(8);
		for (const result of planned) expect(result).not.toContain("recorded a plan");
		expect(lastResults(requests[planner]![2]!)).toContain("recorded a plan of 24 attacks");
		const probed = resultsOf(requests[prober]![1]!);
		expect(probed).toHaveLength(8);
		for (const result of probed) {
			expect(result).not.toContain("recorded attack");
			expect(result).not.toMatch(/probe p[0-9]+ passed/);
		}
		const accepted = resultsOf(requests[prober]![2]!);
		expect(accepted[0]).toMatch(/probe p[0-9]+ passed/);
		expect(accepted.slice(1).every((result) => result.includes("as skipped"))).toBe(true);
		expect(ran.status).toBe("ran");
	});

	it("says how a probe ended: timed out, cut, ended by a signal, or silent", async () => {
		const { run, requests } = await review(
			{
				planner: plan,
				prober: [
					round([
						["run_probe", { attack: 1, script: "setInterval(() => {}, 1000);\n" }],
						[
							"run_probe",
							{ attack: 1, script: 'process.stdout.write("x".repeat(20000));\nsetInterval(() => {}, 1000);\n' },
						],
						["run_probe", { attack: 1, script: 'process.kill(process.pid, "SIGKILL");\n' }],
						["run_probe", { attack: 1, script: "process.exit(0);\n" }],
						["run_probe", { attack: 1, script: 'console.log("held");\nprocess.exit(0);\n' }],
					]),
					fauxAssistantMessage("Done."),
				],
			},
			{ lens: probingWith({ timeout: 1000 }) },
		);
		await run;
		const [timed, cut, killed, silent, spoke] = resultsOf(requests[prober]![1]!);
		expect(timed).toMatch(/probe p[0-9]+ timed out after 1 second, which shows nothing/);
		expect(cut).toMatch(
			/probe p[0-9]+'s output passed its limit, so it was cut and the probe ended, which shows nothing/,
		);
		expect(killed).toMatch(/probe p[0-9]+ was ended by SIGKILL, which shows nothing/);
		expect(silent).toContain("[the probe printed nothing]");
		expect(silent).not.toContain("<untrusted-");
		expect(spoke).toContain("held");
		expect(spoke).not.toContain("[the probe printed nothing]");
	});

	it("tells the prober a probe the sandbox refused did not run", async () => {
		const base = unconfinedSandbox();
		const { run, requests } = await review(
			{ planner: plan, prober: [call("run_probe", { attack: 1, script: passing }), fauxAssistantMessage("Done.")] },
			{
				sandbox: {
					...base,
					wrap: async (command, policy) => {
						if (inHeadTree(command)) throw new Error("no seatbelt now");
						return base.wrap(command, policy);
					},
				},
			},
		);
		await run;
		expect(lastResults(requests[prober]![1]!)).toContain("the probe did not run:");
	});

	it("keeps a probe's files for the verifier, and its rerun reads them", async () => {
		const reading =
			'import { readFileSync } from "node:fs";\nconst text = readFileSync(new URL("./data.txt", import.meta.url), "utf8");\nconsole.log(text);\nprocess.exit(text === "DATA" ? 1 : 0);\n';
		const { run, requests } = await review({
			planner: plan,
			prober: [
				call("run_probe", { attack: 1, script: reading, files: [{ path: "data.txt", text: "DATA" }] }),
				(messages) => call("report_finding", finding(/probe (p[0-9]+)/.exec(lastResults(messages))?.[1] ?? "p0")),
				fauxAssistantMessage("Reported 1 finding."),
			],
		});
		const { verdict } = await run;
		expect(verdict.counted().map((each) => each.properties.verification?.verdict)).toEqual(["confirmed"]);
		const judged = systemPromptOf(requests["Melian adversarial verifier"]![0]!);
		expect(judged).toContain("file data.txt:\nDATA");
		expect(judged).toContain("When Melian ran it again it failed, exiting 1.");
	});

	it("records a finding of a level that does not probe, and gives its verifier no probe", async () => {
		const { probe: _, ...plain } = finding("p1");
		const { run, requests } = await review(
			{
				planner: [],
				prober: [],
				others: [{ match: reviewer, replies: [call("report_finding", plain), fauxAssistantMessage("Done.")] }],
			},
			{ config: { lenses: {} } },
		);
		expect((await run).verdict.counted()).toHaveLength(1);
		const judged = systemPromptOf(requests["Melian adversarial verifier"]![0]!).trimEnd();
		expect(judged).toMatch(/Claim c1 finding [0-9a-f]+, reported at P1\n<\/instructions>$/);
	});

	it("probes a head the reviewer vouches for under a base policy that trusts no writer", async () => {
		withBasePolicy("trust:\n  writers: false\n");
		const { run } = await review({ planner: plan, prober: probing(failing) });
		expect((await run).verdict.counted()).toHaveLength(1);
	});

	it("reminds no planner and no prober whose budget ended", async () => {
		const reads = round([
			["read_file", { path: "src/load.ts" }],
			["read_file", { path: "src/load.ts" }],
		]);
		const planned = await review(
			{ planner: [reads, fauxAssistantMessage("Out of reads.")], prober: [] },
			{ lens: probingWith({}, { tools: 1 }) },
		);
		expect((await failure(planned.run)).code).toBe("lensFailed");
		expect(planned.requests[planner]).toHaveLength(2);
		harness = undefined;
		const probed = await review(
			{
				planner: [call("record_plan", { attacks: [attack, attack] }), plan[1]!],
				prober: [
					round([
						["run_probe", { attack: 1, script: passing }],
						["run_probe", { attack: 1, script: passing }],
					]),
					fauxAssistantMessage("Out."),
				],
			},
			{ lens: probingWith({}, { tools: 1 }) },
		);
		const ended = record((await probed.run).verdict);
		expect(probed.requests[prober]).toHaveLength(2);
		expect(ended.reason).toContain("its prober left attack 2 with neither a probe nor a skip");
		expect(ended.budgetEnded).toMatchObject({ budget: "tools", limit: 1 });
	});

	it("names every attack a prober left unanswered, and no budget that did not end", async () => {
		const { run } = await review({
			planner: [call("record_plan", { attacks: [attack, attack] }), plan[1]!],
			prober: [fauxAssistantMessage("Done."), fauxAssistantMessage("Still done.")],
		});
		const ended = record((await run).verdict);
		expect(ended.reason).toContain("its prober left attacks 1, 2 with neither a probe nor a skip");
		expect(ended).not.toHaveProperty("budgetEnded");
	});

	it("counts the probes' time in seconds", async () => {
		const slow = `await new Promise((resolve) => setTimeout(resolve, 200));\n${failing}`;
		const { run } = await review({ planner: plan, prober: probing(slow) });
		const seconds = Number(/ran 1 probe in ([0-9.]+) s/.exec(record((await run).verdict).reason!)![1]);
		expect(seconds).toBeGreaterThanOrEqual(0.2);
		expect(seconds).toBeLessThan(60);
	});

	it("never says a probe that ran took no time", async () => {
		// A clock that stands still times every probe at 0 ms, as a fast machine's rounding does.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const { run } = await review({ planner: plan, prober: probing(failing) });
			const { reason } = record((await run).verdict);
			expect(reason).toContain("ran 1 probe in under 0.1 s");
			expect(reason).not.toContain("0.0 s");
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives a probing finding its probe beside another lens that reports in the same review", async () => {
		const { probe: _, ...plain } = finding("p1");
		const correctness = "You are the correctness reviewer";
		const { run, requests } = await review(
			{
				planner: plan,
				prober: probing(failing),
				others: [
					{
						match: correctness,
						replies: [
							call("report_finding", {
								...plain,
								rule: "null-dereference",
								line: 2,
								evidence: [{ file: "src/load.ts", line: 2, role: "cause" }],
							}),
							fauxAssistantMessage("Done."),
						],
					},
				],
			},
			{ config: { tiers: { full: ["lens.trust-boundary", "lens.correctness"] } } },
		);
		const { verdict } = await run;
		expect(verdict.counted()).toHaveLength(2);
		const prompts = [...new Set(requests["Melian adversarial verifier"]!.map(systemPromptOf))];
		expect(prompts).toHaveLength(2);
		expect(prompts.filter((prompt) => prompt.includes("rests on probe p"))).toHaveLength(1);
	});

	it("verifies a probing claim only after its probe runs again, though another lens still runs when it ends", async () => {
		const { probe: _, ...plain } = finding("p1");
		let asked!: () => void;
		const verifying = new Promise<void>((resolve) => {
			asked = resolve;
		});
		// Correctness holds its report until a verifier is asked, or a second passes, so a wave that verified the probing
		// claim while correctness ran would ask first.
		const slow: ScriptedReply = async () => {
			await Promise.race([verifying, new Promise((resolve) => setTimeout(resolve, 1_000))]);
			return call("report_finding", {
				...plain,
				rule: "null-dereference",
				line: 2,
				evidence: [{ file: "src/load.ts", line: 2, role: "cause" }],
			});
		};
		const judge: ScriptedReply = (messages) => {
			asked();
			return scriptVerifier(messages);
		};
		const { run, requests } = await review(
			{
				planner: plan,
				prober: probing(failing),
				others: [
					{ match: "Melian adversarial verifier", replies: [judge, judge, judge, judge] },
					{ match: "You are the correctness reviewer", replies: [slow, fauxAssistantMessage("Done.")] },
				],
			},
			{ config: { tiers: { full: ["lens.trust-boundary", "lens.correctness"] } } },
		);
		expect((await run).verdict.counted()).toHaveLength(2);
		const prompts = [...new Set(requests["Melian adversarial verifier"]!.map(systemPromptOf))];
		expect(prompts).toHaveLength(2);
		expect(prompts.filter((prompt) => prompt.includes("When Melian ran it again it failed"))).toHaveLength(1);
	});

	it("runs each merged claim's probe again under its own lens's time limit", async () => {
		// A planner records its plan on its first turn and finishes on its next, whichever lens's planner asks.
		const planning: ScriptedReply = (messages) =>
			messages.some((message) => message.role === "assistant")
				? fauxAssistantMessage("Planned 1 attack.")
				: call("record_plan", { attacks: [attack] });
		// A copy of trust-boundary shares its rules, so the two lenses' reports of one defect merge into one finding.
		const copy = (loaded: readonly Lens[]) => [
			probingWith({ timeout: 40_000 })(
				Lens.from({ ...loaded.find((lens) => lens.name === "trust-boundary")!.toJSON(), name: "boundary-copy" }),
			),
		];
		const { run, heads } = await review(
			{
				planner: [planning, planning, planning, planning],
				prober: probing(failing),
				others: [{ match: "You are the prober for the boundary-copy lens", replies: probing(failing) }],
			},
			{
				config: {
					tiers: { full: ["lens.trust-boundary", "lens.boundary-copy"] },
					lenses: {
						"trust-boundary": { level: { floor: "deep" } },
						"boundary-copy": { level: { floor: "deep" } },
					},
				},
				lens: probingWith({ timeout: 20_000 }),
				lenses: copy,
			},
		);
		const { verdict } = await run;
		expect(verdict.counted()).toHaveLength(1);
		// Each lens's limit shows as the CPU-time limit of its prober's probe and of that probe's rerun.
		const limits = heads.map((command) => /ulimit -t ([0-9]+)/.exec(command)![1]);
		expect(limits.toSorted()).toEqual(["27", "27", "47", "47"]);
	});

	it("names no role for the verifier's stage", async () => {
		const { run, changeset } = await review({ planner: plan, prober: probing(failing) });
		await run;
		const telemetry = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		const verifier = telemetry.stages.filter((stage) => stage.name === "melian.verification.candidate");
		expect(verifier.length).toBeGreaterThan(0);
		for (const stage of verifier) expect(stage).not.toHaveProperty("role");
	});

	it("moves a prober whose model hits its usage limit to its next model", async () => {
		const fake = createFakeModels({ models: [{ id: "planning" }, { id: "first" }, { id: "second" }] });
		const seen: string[] = [];
		const limited: ScriptedReply = (_, model) => {
			seen.push(model);
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage_limit_reached" });
		};
		const on =
			(reply: ScriptedReply): ScriptedReply =>
			(messages, model) => {
				seen.push(model);
				return typeof reply === "function" ? reply(messages, model) : reply;
			};
		const provider = fake.ref("planning").provider;
		const { run, requests } = await review(
			{
				planner: plan,
				prober: [limited, on(call("skip_attack", { attack: 1, reason: "r" })), on(fauxAssistantMessage("Done."))],
			},
			{
				fake,
				lens: probingWith({ prober: "light" }),
				config: {
					models: {
						heavy: { model: `${provider}/planning` },
						light: { model: `${provider}/first`, fallbacks: [`${provider}/second`] },
					},
				},
			},
		);
		expect(record((await run).verdict).status).toBe("ran");
		expect(seen).toEqual(["first", "second", "second"]);
		expect(textOf(requests[prober]![1]!.at(-1)!)).toContain(
			"The model reviewing this change failed, and you take over.",
		);
	});

	it("fails a lens whose prober's every model failed, naming them", async () => {
		const fake = createFakeModels({ models: [{ id: "planning" }, { id: "first" }, { id: "second" }] });
		const limited = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage_limit_reached" });
		const provider = fake.ref("planning").provider;
		const { run } = await review(
			{ planner: plan, prober: [limited, limited] },
			{
				fake,
				lens: probingWith({ prober: "light" }),
				config: {
					models: {
						heavy: { model: `${provider}/planning` },
						light: { model: `${provider}/first`, fallbacks: [`${provider}/second`] },
					},
				},
			},
		);
		const error = await failure(run);
		expect(error.code).toBe("allModelsFailed");
		expect(error.message).toContain(`tried ${provider}/first, ${provider}/second`);
	});

	it("fails a moved lens whose prober, on the lens's own tier, finished on a model the committed tier refuses", async () => {
		const fake = createFakeModels({ models: [{ id: "plan" }, { id: "backup" }] });
		const provider = fake.ref("plan").provider;
		const [accepted, backup] = [`${provider}/plan`, `${provider}/backup`];
		const committed = { model: accepted, accept: [accepted], acceptOverridden: false as const };
		const overloaded = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded_error" });
		const { run, requests } = await review(
			// The prober's first request, on the accepted model, fails, so it goes on on the fallback.
			{ planner: plan, prober: [() => overloaded, ...probing(failing)] },
			{
				fake,
				config: {
					// A preference file moves the lens to light, whose route starts inside heavy's accept and leaves it.
					lenses: { "trust-boundary": { tier: "light", level: { floor: "deep" } } },
					models: { heavy: committed, light: { model: accepted, fallbacks: [backup] } },
				},
				plan: async (config, lenses, models) => {
					const { catalog, credentials } = await planInputs(models.review);
					return ReviewPlan.resolve({
						config,
						routes: {
							committed: { heavy: committed },
							overridden: { light: "melian.local.yaml" },
							lensTiers: {},
							retiered: { "trust-boundary": "melian.local.yaml" },
						},
						catalog,
						credentials,
						lenses,
						checks: ["lens.trust-boundary"],
					});
				},
			},
		);
		// A failed lens leaves the review not reviewed, which rejects with the verdict.
		const verdict = await run.then(
			(done) => done.verdict,
			(error: unknown) => (error as ReviewError).verdict!,
		);
		expect(requests[prober]).toHaveLength(4);
		const ran = record(verdict);
		expect(ran).toMatchObject({ status: "failed" });
		expect(ran.reason).toContain("models.heavy.acceptOverridden is false");
	});

	it("runs a moved lens again under --rerun when only its prober finished on a model the committed tier refuses", async () => {
		const fake = createFakeModels({ models: [{ id: "plan" }, { id: "backup" }] });
		const provider = fake.ref("plan").provider;
		const [accepted, backup] = [`${provider}/plan`, `${provider}/backup`];
		const committed = { model: accepted, accept: [accepted], acceptOverridden: false as const };
		const overloaded = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded_error" });
		const options = (rerun: boolean): Parameters<typeof review>[1] => ({
			fake,
			rerun,
			config: {
				lenses: { "trust-boundary": { tier: "light", level: { floor: "deep" } } },
				models: { heavy: committed, light: { model: accepted, fallbacks: [backup] } },
			},
			plan: async (config, lenses, models) => {
				const { catalog, credentials } = await planInputs(models.review);
				return ReviewPlan.resolve({
					config,
					routes: {
						committed: { heavy: committed },
						overridden: { light: "melian.local.yaml" },
						lensTiers: {},
						retiered: { "trust-boundary": "melian.local.yaml" },
					},
					catalog,
					credentials,
					lenses,
					checks: ["lens.trust-boundary"],
				});
			},
		});
		const first = await review({ planner: plan, prober: [() => overloaded, ...probing(failing)] }, options(false));
		await first.run.catch(() => undefined);
		const again = await review({ planner: plan, prober: probing(failing) }, options(true));
		await again.run.catch(() => undefined);
		expect(again.requests[planner]).toHaveLength(2);
		expect(record((await again.run).verdict)).toMatchObject({ status: "ran" });
	});

	it.each([
		["the root's", false],
		["the scoped variant's", true],
	])("fails a moved lens when %s prober alone finished on a model the committed tier refuses", async (_, scoped) => {
		rmSync(repo, { recursive: true, force: true });
		// The variant's prober has a time limit of its own, which its instructions state.
		const marker = "It has 20 seconds";
		repo = baseAndHead(
			{
				...baseFiles,
				"src/.melian/lenses/trust-boundary/LENS.md": "---\nname: trust-boundary\nextends: trust-boundary\n---\n",
			},
			headFiles,
		);
		const fake = createFakeModels({ models: [{ id: "plan" }, { id: "backup" }] });
		const provider = fake.ref("plan").provider;
		const [accepted, backup] = [`${provider}/plan`, `${provider}/backup`];
		const committed = { model: accepted, accept: [accepted], acceptOverridden: false as const };
		let overloaded = false;
		// Each conversation's turn by what it holds, so the two variants' conversations can interleave on one queue.
		const planning: ScriptedReply = (messages) =>
			messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage("Planned 1 attack.")
				: call("record_plan", { attacks: [attack] });
		const probingTurn: ScriptedReply = (messages, model) => {
			if (!overloaded && model === "plan" && systemPromptOf(messages).includes(marker) === scoped) {
				overloaded = true;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded_error" });
			}
			const results = messages.filter((message) => message.role === "toolResult").map(textOf);
			const probe = /probe (p[0-9]+) failed/.exec(results.join("\n"))?.[1];
			if (probe === undefined) return call("run_probe", { attack: 1, script: failing });
			if (results.some((text) => text.includes("recorded finding")))
				return fauxAssistantMessage("Reported 1 finding.");
			// The variant reviews src/; the root lens what lies outside it.
			if (!results.some((text) => text.includes("outside the paths"))) return call("report_finding", finding(probe));
			const outside = { file: "fixture/leak.txt", line: 1 };
			return call("report_finding", { ...finding(probe), ...outside, evidence: [{ ...outside, role: "cause" }] });
		};
		const { run } = await review(
			{ planner: Array.from({ length: 8 }, () => planning), prober: Array.from({ length: 16 }, () => probingTurn) },
			{
				fake,
				lens: (lens) => probingWith({ timeout: lens.scope === "" ? 30_000 : 20_000 })(lens),
				config: {
					lenses: { "trust-boundary": { tier: "light", level: { floor: "deep" } } },
					models: { heavy: committed, light: { model: accepted, fallbacks: [backup] } },
				},
				plan: async (config, lenses, models) => {
					const { catalog, credentials } = await planInputs(models.review);
					return ReviewPlan.resolve({
						config,
						routes: {
							committed: { heavy: committed },
							overridden: { light: "melian.local.yaml" },
							lensTiers: {},
							retiered: { "trust-boundary": "melian.local.yaml" },
						},
						catalog,
						credentials,
						lenses,
						checks: ["lens.trust-boundary"],
					});
				},
			},
		);
		const verdict = await run.then(
			(done) => done.verdict,
			(error: unknown) => (error as ReviewError).verdict!,
		);
		expect(overloaded).toBe(true);
		const records = [...(verdict.ran ?? []), ...verdict.notRun].filter(({ name }) => name === "lens.trust-boundary");
		// Only the variant whose prober left the accepted route fails.
		expect(records.map(({ status }) => status).sort()).toEqual(["failed", "ran"]);
		expect(verdict.status).toBe("not-reviewed");
	});

	it("keeps the plan's reason for a moved lens whose planner and prober both left accept", async () => {
		const fake = createFakeModels({ models: [{ id: "plan" }, { id: "first" }, { id: "second" }] });
		const provider = fake.ref("plan").provider;
		const accepted = `${provider}/plan`;
		const committed = { model: accepted, accept: [accepted], acceptOverridden: false as const };
		const overloaded = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded_error" });
		const { run } = await review(
			// The planner fails over twice and finishes on the second fallback; the prober once, onto the first.
			{ planner: [() => overloaded, () => overloaded, ...plan], prober: [() => overloaded, ...probing(failing)] },
			{
				fake,
				config: {
					lenses: { "trust-boundary": { tier: "light", level: { floor: "deep" } } },
					models: {
						heavy: committed,
						light: { model: accepted, fallbacks: [`${provider}/first`, `${provider}/second`] },
					},
				},
				plan: async (config, lenses, models) => {
					const { catalog, credentials } = await planInputs(models.review);
					return ReviewPlan.resolve({
						config,
						routes: {
							committed: { heavy: committed },
							overridden: { light: "melian.local.yaml" },
							lensTiers: {},
							retiered: { "trust-boundary": "melian.local.yaml" },
						},
						catalog,
						credentials,
						lenses,
						checks: ["lens.trust-boundary"],
					});
				},
			},
		);
		const verdict = await run.then(
			(done) => done.verdict,
			(error: unknown) => (error as ReviewError).verdict!,
		);
		const ran = record(verdict);
		expect(ran).toMatchObject({ status: "failed" });
		expect(ran.reason).toContain(`${provider}/second`);
	});

	it("judges a prober on a tier of its own by that tier, not its level's", async () => {
		const fake = createFakeModels({ models: [{ id: "plan" }, { id: "probe" }] });
		const provider = fake.ref("plan").provider;
		const accepted = `${provider}/plan`;
		const committed = { model: accepted, accept: [accepted], acceptOverridden: false as const };
		const options = (rerun: boolean): Parameters<typeof review>[1] => ({
			fake,
			rerun,
			lens: probingWith({ prober: "light" }),
			config: { models: { heavy: committed, light: { model: `${provider}/probe` } } },
			plan: async (config, lenses, models) => {
				const { catalog, credentials } = await planInputs(models.review);
				return ReviewPlan.resolve({
					config,
					routes: { committed: config.models, overridden: {}, lensTiers: {}, retiered: {} },
					catalog,
					credentials,
					lenses,
					checks: ["lens.trust-boundary"],
				});
			},
		});
		const { run } = await review({ planner: plan, prober: probing(failing) }, options(false));
		expect(record((await run).verdict)).toMatchObject({ status: "ran", level: "deep" });
		// --rerun runs again only what failed, and this prober did not.
		const again = await review({ planner: plan, prober: probing(failing) }, options(true));
		await again.run;
		expect(again.requests[planner] ?? []).toHaveLength(0);
	});

	it("chooses the verifier against the prober's family, which reported the finding, not the planner's", async () => {
		const fake = createFakeModels({
			models: [
				{ id: "plan", name: "Claude Planner" },
				{ id: "probe", name: "GPT Prober" },
				{ id: "claude-judge", name: "Claude Judge" },
				{ id: "gpt-judge", name: "GPT Judge" },
			],
		});
		const provider = fake.ref("plan").provider;
		const judged: string[] = [];
		const judge: ScriptedReply = (messages, model) => {
			judged.push(model);
			return scriptVerifier(messages);
		};
		const { run } = await review(
			{
				planner: plan,
				prober: probing(failing),
				others: [{ match: "Melian adversarial verifier", replies: [judge, judge] }],
			},
			{
				fake,
				lens: probingWith({ prober: "light" }),
				config: {
					models: {
						heavy: { model: `${provider}/plan` },
						light: { model: `${provider}/probe` },
						verifier: { model: `${provider}/gpt-judge`, fallbacks: [`${provider}/claude-judge`] },
					},
				},
				plan: async (config, lenses, models) => {
					const { catalog, credentials } = await planInputs(models.review);
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
		expect((await run).verdict.counted()).toHaveLength(1);
		expect(judged[0]).toBe("claude-judge");
	});

	it("chooses the verifier against the family of the model the prober finished on, not its first", async () => {
		const fake = createFakeModels({
			models: [
				{ id: "plan", name: "Claude Planner" },
				{ id: "first", name: "Claude Prober" },
				{ id: "second", name: "GPT Prober" },
				{ id: "claude-judge", name: "Claude Judge" },
				{ id: "gpt-judge", name: "GPT Judge" },
			],
		});
		const provider = fake.ref("plan").provider;
		const limited: ScriptedReply = () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage_limit_reached" });
		const judged: string[] = [];
		const judge: ScriptedReply = (messages, model) => {
			judged.push(model);
			return scriptVerifier(messages);
		};
		const { run } = await review(
			{
				planner: plan,
				prober: [limited, ...probing(failing)],
				others: [{ match: "Melian adversarial verifier", replies: [judge, judge] }],
			},
			{
				fake,
				lens: probingWith({ prober: "light" }),
				config: {
					models: {
						heavy: { model: `${provider}/plan` },
						light: { model: `${provider}/first`, fallbacks: [`${provider}/second`] },
						verifier: { model: `${provider}/gpt-judge`, fallbacks: [`${provider}/claude-judge`] },
					},
				},
				plan: async (config, lenses, models) => {
					const { catalog, credentials } = await planInputs(models.review);
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
		expect((await run).verdict.counted()).toHaveLength(1);
		expect(judged[0]).toBe("claude-judge");
	});

	it("judges a finding from a level without probes on its lens's route when no verifier route is named", async () => {
		const judged: string[] = [];
		const judge: ScriptedReply = (messages, model) => {
			judged.push(model);
			return scriptVerifier(messages);
		};
		const { probe: _, ...plain } = finding("p0");
		const { run } = await review(
			{
				planner: [],
				prober: [],
				others: [
					{ match: "Melian adversarial verifier", replies: [judge, judge] },
					{
						match: reviewer,
						replies: [call("report_finding", plain), fauxAssistantMessage("Reported 1 finding.")],
					},
				],
			},
			{ lens: (lens) => lens },
		);
		expect((await run).verdict.counted()).toHaveLength(1);
		expect(judged[0]).toBe("faux-1");
	});

	it("attaches a repeat review to a verification stored before reruns joined its key, for a level without probes", async () => {
		const fake = createFakeModels();
		let judged = 0;
		const judge: ScriptedReply = (messages) => {
			judged++;
			return scriptVerifier(messages);
		};
		const { probe: _, ...plain } = finding("p0");
		const scripts = {
			planner: [],
			prober: [],
			others: [
				{ match: "Melian adversarial verifier", replies: [judge, judge] },
				{ match: reviewer, replies: [call("report_finding", plain), fauxAssistantMessage("Reported 1 finding.")] },
			],
		};
		const first = await review(scripts, { fake, lens: (lens) => lens });
		expect((await first.run).verdict.counted()).toHaveLength(1);
		expect(judged).toBe(2);
		// The key as the build before reruns joined it wrote it: the same fields, in the same order, without reruns.
		const root = await harness!.harness.root(backgroundContext);
		const verification = async () =>
			(await harness!.harness.snapshot(ReviewIndex, root.id, backgroundContext))!.reviews[
				Revision.key(first.changeset.revision)
			]!.verification!.task;
		const stored = await verification();
		await root.commit(async (tx) => {
			const entry = (await tx.doc(ReviewIndex, root.id)).reviews[Revision.key(first.changeset.revision)]!;
			const { reruns: __, ...older } = JSON.parse(entry.verification!.input) as Record<string, unknown>;
			entry.verification = { ...entry.verification!, input: JSON.stringify(older) };
		}, backgroundContext);
		const again = await review(scripts, { fake, lens: (lens) => lens });
		expect((await again.run).verdict.counted()).toHaveLength(1);
		expect(judged).toBe(2);
		expect(await verification()).toBe(stored);
	});

	it("runs a probing level again when the probing protocol changes, as a release that lowers a fixed limit does", async () => {
		const fake = createFakeModels();
		const first = await review({ planner: plan, prober: probing(failing) }, { fake });
		await first.run.catch(() => undefined);
		const limits = probingLimits as { probes: number };
		const probes = limits.probes;
		limits.probes = probes - 1;
		onTestFinished(() => {
			limits.probes = probes;
		});
		const again = await review({ planner: plan, prober: probing(failing) }, { fake });
		await again.run.catch(() => undefined);
		expect(again.requests[planner]).toHaveLength(2);
	});

	it("runs a probing level again when a role tool's contract changes, as a release that rewrites one does", async () => {
		const fake = createFakeModels();
		const first = await review({ planner: plan, prober: probing(failing) }, { fake });
		await first.run.catch(() => undefined);
		const tool = skipAttack as { description: string };
		const description = tool.description;
		tool.description = `${description} Name the attack's number.`;
		onTestFinished(() => {
			tool.description = description;
		});
		const again = await review({ planner: plan, prober: probing(failing) }, { fake });
		await again.run.catch(() => undefined);
		expect(again.requests[planner]).toHaveLength(2);
	});

	it("runs as many probes as a prober may, and refuses one past them whatever its budget", async () => {
		const limits = probingLimits as { probes: number };
		const probes = limits.probes;
		limits.probes = 2;
		onTestFinished(() => {
			limits.probes = probes;
		});
		const { run, requests } = await review({
			planner: plan,
			prober: [
				call("run_probe", { attack: 1, script: passing }),
				call("run_probe", { attack: 1, script: passing }),
				call("run_probe", { attack: 1, script: passing }),
				call("skip_attack", { attack: 1, reason: "r" }),
				fauxAssistantMessage("Done."),
			],
		});
		await run;
		expect(lastResults(requests[prober]![2]!)).toMatch(/^probe p[0-9]+ passed/);
		expect(lastResults(requests[prober]![3]!)).toContain(
			"a prober runs at most 2 probes; answer the attacks left with skip_attack",
		);
		expect(probes).toBe(48);
	});

	it("lets a probe read what the base policy's probe.read allows beyond the head's tree", async () => {
		withBasePolicy("probe:\n  read: [node_modules, generated.txt]\n");
		writeFileSync(join(repo, "generated.txt"), "BUILT\n");
		const reading =
			'import { readFileSync } from "node:fs";\nconsole.log(readFileSync("generated.txt", "utf8").trim());\n';
		const { run, requests } = await review(
			{
				planner: plan,
				prober: [call("run_probe", { attack: 1, script: reading }), fauxAssistantMessage("Reported 0 findings.")],
			},
			{},
		);
		await run;
		expect(lastResults(requests[prober]![1]!)).toContain("BUILT");
	});

	it("keeps only the reruns the revision's current claims rest on, however often a failed prober is run again", async () => {
		const fake = createFakeModels();
		const reported = () => probing(failing).slice(0, 2);
		const first = await review({ planner: plan, prober: reported() }, { fake });
		expect((await failure(first.run)).code).toBe("lensFailed");
		const again = await review({ planner: plan, prober: reported() }, { fake, rerun: true });
		expect((await failure(again.run)).code).toBe("lensFailed");
		const root = (await harness!.harness.root(backgroundContext)).id;
		const runs = (await harness!.harness.snapshot(ProbeReruns, root, backgroundContext))!.runs[
			Revision.key(again.changeset.revision)
		]!;
		expect(Object.keys(runs)).toHaveLength(1);
	});

	it("counts a refused probe toward a prober's limit, and refuses one past it without starting the sandbox", async () => {
		const limits = probingLimits as { probes: number };
		const probes = limits.probes;
		limits.probes = 1;
		onTestFinished(() => {
			limits.probes = probes;
		});
		let wraps = 0;
		const base = unconfinedSandbox();
		const sandbox: ProbeSandbox = {
			...base,
			wrap: async (command, policy) => {
				if (!inHeadTree(command)) return base.wrap(command, policy);
				wraps++;
				throw new Error("the sandbox refused");
			},
		};
		const { run, requests } = await review(
			{
				planner: plan,
				prober: [
					call("run_probe", { attack: 1, script: passing }),
					call("run_probe", { attack: 1, script: passing }),
					call("skip_attack", { attack: 1, reason: "r" }),
					fauxAssistantMessage("Done."),
				],
			},
			{ sandbox },
		);
		await run;
		expect(wraps).toBe(1);
		expect(lastResults(requests[prober]![2]!)).toContain(
			"a prober runs at most 1 probes; answer the attacks left with skip_attack",
		);
	});

	it("runs a probing run a quick one escalates to again when its probing environment changes, as a first run does", async () => {
		const fake = createFakeModels();
		const { probe: _, ...plain } = finding("p0");
		const scripts = {
			planner: [],
			prober: probing(failing),
			// The planner's script goes first, since its instructions hold the reviewer's too.
			others: [
				{ match: planner, replies: plan },
				{ match: reviewer, replies: [call("report_finding", plain), fauxAssistantMessage("Reported 1 finding.")] },
			],
		};
		const route = `${fake.ref().provider}/${fake.ref().modelId}`;
		const careful = (lens: Lens) =>
			Lens.from({ ...lens.toJSON(), levels: { ...lens.levels, careful: { ...lens.level("careful"), probe: {} } } });
		// Triage sends the lens to quick, whose finding escalates it to careful, the level that probes.
		const decider = new RecordedDecider(
			{ triage: { version: "1", answers: { "trust-boundary": { distribution: { quick: 1 } } } } },
			{ name: "recorded" },
		);
		const at = (writer: ReviewOptions["writer"]) => ({
			fake,
			decider,
			writer,
			lens: careful,
			config: {
				lenses: { "trust-boundary": { level: { floor: "quick" as const, ceiling: "careful" as const } } },
				// Quick runs on medium, so it needs a route too.
				models: { heavy: { model: route }, medium: { model: route } },
			},
		});
		const first = await review(scripts, at({ trusted: true, by: "reviewer" }));
		const done = await first.run;
		expect(record(done.verdict)).toMatchObject({ level: "careful" });
		expect(first.requests[reviewer]).toHaveLength(2);
		expect(first.requests[planner]).toHaveLength(2);
		const again = await review(scripts, at({ trusted: true, by: "writer" }));
		await again.run;
		expect(again.requests[planner]).toHaveLength(2);
	});

	it("keeps a finding a quick run carried when the planner of the level it escalates to calls it refuted", async () => {
		const fake = createFakeModels();
		const { probe: _, ...plain } = finding("p0");
		// The planner reads the carried finding's ID in its prompt and tries to refute it under the one rule it may report.
		const refute: ScriptedReply = (messages) => {
			const id =
				/([0-9a-f]{16}) P1 path-traversal/.exec(systemPromptOf(messages) + JSON.stringify(messages))?.[1] ?? "none";
			return call("report_finding", {
				...plain,
				rule: "melian/injection-attempt",
				severity: "P2",
				refuted: id,
			});
		};
		const scripts = {
			planner: [],
			prober: [],
			others: [
				{
					match: planner,
					replies: [refute, call("record_plan", { attacks: [] }), fauxAssistantMessage("Planned 0 attacks.")],
				},
				{ match: reviewer, replies: [call("report_finding", plain), fauxAssistantMessage("Reported 1 finding.")] },
			],
		};
		const route = `${fake.ref().provider}/${fake.ref().modelId}`;
		const careful = (lens: Lens) =>
			Lens.from({ ...lens.toJSON(), levels: { ...lens.levels, careful: { ...lens.level("careful"), probe: {} } } });
		const decider = new RecordedDecider(
			{ triage: { version: "1", answers: { "trust-boundary": { distribution: { quick: 1 } } } } },
			{ name: "recorded" },
		);
		const { run } = await review(scripts, {
			fake,
			decider,
			lens: careful,
			config: {
				lenses: { "trust-boundary": { level: { floor: "quick" as const, ceiling: "careful" as const } } },
				models: { heavy: { model: route }, medium: { model: route } },
			},
		});
		const { verdict } = await run.catch((error: ReviewError) => ({ verdict: error.verdict! }));
		expect(verdict.counted().map((each) => each.ruleId)).toContain("path-traversal");
	});

	it("lets the prober refute a finding a quick run carried, with a probe that passed", async () => {
		const fake = createFakeModels();
		const { probe: _, ...plain } = finding("p0");
		let probe = "p0";
		const refute: ScriptedReply = (messages) => {
			probe = /probe (p[0-9]+)/.exec(lastResults(messages))?.[1] ?? probe;
			const id = /([0-9a-f]{16}) P1 path-traversal/.exec(JSON.stringify(messages))?.[1] ?? "none";
			return call("report_finding", { ...finding(probe), refuted: id });
		};
		const scripts = {
			planner: [],
			prober: [
				call("run_probe", { attack: 1, script: passing }),
				refute,
				fauxAssistantMessage("Refuted 1 finding."),
			],
			others: [
				{ match: planner, replies: plan },
				{ match: reviewer, replies: [call("report_finding", plain), fauxAssistantMessage("Reported 1 finding.")] },
			],
		};
		const route = `${fake.ref().provider}/${fake.ref().modelId}`;
		const careful = (lens: Lens) =>
			Lens.from({ ...lens.toJSON(), levels: { ...lens.levels, careful: { ...lens.level("careful"), probe: {} } } });
		const decider = new RecordedDecider(
			{ triage: { version: "1", answers: { "trust-boundary": { distribution: { quick: 1 } } } } },
			{ name: "recorded" },
		);
		const { run } = await review(scripts, {
			fake,
			decider,
			lens: careful,
			config: {
				lenses: { "trust-boundary": { level: { floor: "quick" as const, ceiling: "careful" as const } } },
				models: { heavy: { model: route }, medium: { model: route } },
			},
		});
		const { verdict } = await run.catch((error: ReviewError) => ({ verdict: error.verdict! }));
		expect(record(verdict).reason).toContain("careful refuted 1 finding quick carried");
		expect(verdict.counted().map((each) => each.ruleId)).not.toContain("path-traversal");
	});

	it("refuses a prober's refutation that rests on a probe that failed, and keeps the carried finding", async () => {
		const fake = createFakeModels();
		const { probe: _, ...plain } = finding("p0");
		let probe = "p0";
		const refute: ScriptedReply = (messages) => {
			probe = /probe (p[0-9]+)/.exec(lastResults(messages))?.[1] ?? probe;
			const id = /([0-9a-f]{16}) P1 path-traversal/.exec(JSON.stringify(messages))?.[1] ?? "none";
			return call("report_finding", { ...finding(probe), refuted: id });
		};
		const { run, requests } = await review(
			{
				planner: [],
				prober: [
					call("run_probe", { attack: 1, script: failing }),
					refute,
					fauxAssistantMessage("Refuted 1 finding."),
				],
				others: [
					{ match: planner, replies: plan },
					{
						match: reviewer,
						replies: [call("report_finding", plain), fauxAssistantMessage("Reported 1 finding.")],
					},
				],
			},
			{
				fake,
				decider: new RecordedDecider(
					{ triage: { version: "1", answers: { "trust-boundary": { distribution: { quick: 1 } } } } },
					{ name: "recorded" },
				),
				lens: (lens) =>
					Lens.from({
						...lens.toJSON(),
						levels: { ...lens.levels, careful: { ...lens.level("careful"), probe: {} } },
					}),
				config: {
					lenses: { "trust-boundary": { level: { floor: "quick" as const, ceiling: "careful" as const } } },
					models: {
						heavy: { model: `${fake.ref().provider}/${fake.ref().modelId}` },
						medium: { model: `${fake.ref().provider}/${fake.ref().modelId}` },
					},
				},
			},
		);
		const { verdict } = await run.catch((error: ReviewError) => ({ verdict: error.verdict! }));
		expect(lastResults(requests[prober]![2]!)).toContain("did not pass, so it shows no finding wrong");
		expect(record(verdict).reason).toContain("which careful neither restated nor refuted, still counts");
	});

	it("keeps a quick run's finding at its severity when the planner it escalates to reports it again lower", async () => {
		const fake = createFakeModels();
		const injection = {
			file: "src/load.ts",
			line: 3,
			rule: "melian/injection-attempt",
			explanation: {
				what: "the change tells the reviewer what to find",
				why: "it steers the review",
				fix: "remove it",
			},
			failureScenario: "a reviewer that follows the text reports nothing",
			evidence: [{ file: "src/load.ts", line: 3, role: "cause" }],
		};
		const scripts = {
			planner: [],
			prober: [],
			others: [
				{
					match: planner,
					replies: [
						call("report_finding", { ...injection, severity: "P2" }),
						call("record_plan", { attacks: [] }),
						fauxAssistantMessage("Planned 0 attacks."),
					],
				},
				{
					match: reviewer,
					replies: [
						call("report_finding", { ...injection, severity: "P1" }),
						fauxAssistantMessage("Reported 1 finding."),
					],
				},
			],
		};
		const route = `${fake.ref().provider}/${fake.ref().modelId}`;
		const { run } = await review(scripts, {
			fake,
			decider: new RecordedDecider(
				{ triage: { version: "1", answers: { "trust-boundary": { distribution: { quick: 1 } } } } },
				{ name: "recorded" },
			),
			lens: (lens) =>
				Lens.from({
					...lens.toJSON(),
					levels: { ...lens.levels, careful: { ...lens.level("careful"), probe: {} } },
				}),
			config: {
				lenses: { "trust-boundary": { level: { floor: "quick" as const, ceiling: "careful" as const } } },
				models: { heavy: { model: route }, medium: { model: route } },
			},
		});
		const { verdict } = await run.catch((error: ReviewError) => ({ verdict: error.verdict! }));
		expect(record(verdict).reason).toContain("which careful neither restated nor refuted, still counts");
		expect(verdict.counted().map((each) => [each.ruleId, each.properties.severity])).toContainEqual([
			"melian/injection-attempt",
			"P1",
		]);
	});

	it("plans from the findings of the revision before this one, never a later one", async () => {
		const fake = createFakeModels();
		const scripts = { planner: plan, prober: probing(failing) };
		await (await review(scripts, { fake })).run;
		const first = gitIn(repo, "rev-parse", "HEAD");
		writeFiles(repo, { "src/other.ts": "export const other = 1;\n" });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "later");
		const later = await review(scripts, { fake });
		await later.run;
		expect(systemPromptOf(later.requests[planner]![0]!)).toContain("load reads any path");
		gitIn(repo, "reset", "--quiet", "--hard", first);
		const again = await review(scripts, { fake, writer: { trusted: true, by: "writer" } });
		await again.run;
		expect(systemPromptOf(again.requests[planner]![0]!)).not.toContain("load reads any path");
	});

	it("attaches a repeat review of a head whose earlier revision's findings changed since", async () => {
		const fake = createFakeModels();
		const scripts = { planner: plan, prober: probing(failing) };
		await (await review(scripts, { fake })).run;
		const first = gitIn(repo, "rev-parse", "HEAD");
		writeFiles(repo, { "src/other.ts": "export const other = 1;\n" });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "later");
		const later = gitIn(repo, "rev-parse", "HEAD");
		await (await review(scripts, { fake })).run;
		// The first revision is reviewed again under another writer's word and now reports nothing.
		gitIn(repo, "reset", "--quiet", "--hard", first);
		const quiet = {
			planner: plan,
			prober: [call("skip_attack", { attack: 1, reason: "r" }), fauxAssistantMessage("Done.")],
		};
		await (await review(quiet, { fake, writer: { trusted: true, by: "writer" } })).run;
		gitIn(repo, "reset", "--quiet", "--hard", later);
		const again = await review(scripts, { fake });
		await again.run;
		expect(again.requests[planner] ?? []).toHaveLength(0);
	});

	it("gives a raw harness's registry no sandbox but the one its review checks probes under", () => {
		// @ts-expect-error A raw harness's review checks and reruns probes under sandbox-runtime, so its registry takes no other.
		expect(createReviewRegistry(unconfinedSandbox())).toBeDefined();
	});

	it("judges a prober's finding on the prober's route when no verifier route is named", async () => {
		const fake = createFakeModels({ models: [{ id: "plan" }, { id: "probe" }] });
		const provider = fake.ref("plan").provider;
		const judged: string[] = [];
		const judge: ScriptedReply = (messages, model) => {
			judged.push(model);
			return scriptVerifier(messages);
		};
		const { run } = await review(
			{
				planner: plan,
				prober: probing(failing),
				others: [{ match: "Melian adversarial verifier", replies: [judge, judge] }],
			},
			{
				fake,
				lens: probingWith({ prober: "light" }),
				config: { models: { heavy: { model: `${provider}/plan` }, light: { model: `${provider}/probe` } } },
			},
		);
		expect((await run).verdict.counted()).toHaveLength(1);
		expect(judged[0]).toBe("probe");
	});

	it("chooses the verifier against the prober's family for a finding whose prober failed after reporting it", async () => {
		const fake = createFakeModels({
			models: [
				{ id: "plan", name: "Claude Planner" },
				{ id: "probe", name: "GPT Prober" },
				{ id: "claude-judge", name: "Claude Judge" },
				{ id: "gpt-judge", name: "GPT Judge" },
			],
		});
		const provider = fake.ref("plan").provider;
		const judged: string[] = [];
		const judge: ScriptedReply = (messages, model) => {
			judged.push(model);
			return scriptVerifier(messages);
		};
		const { run } = await review(
			{
				planner: plan,
				prober: probing(failing).slice(0, 2),
				others: [{ match: "Melian adversarial verifier", replies: [judge, judge] }],
			},
			{
				fake,
				lens: probingWith({ prober: "light" }),
				config: {
					models: {
						heavy: { model: `${provider}/plan` },
						light: { model: `${provider}/probe` },
						verifier: { model: `${provider}/gpt-judge`, fallbacks: [`${provider}/claude-judge`] },
					},
				},
				plan: async (config, lenses, models) => {
					const { catalog, credentials } = await planInputs(models.review);
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
		expect((await failure(run)).code).toBe("lensFailed");
		expect(judged[0]).toBe("claude-judge");
	});
});
