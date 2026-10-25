import {
	Changeset,
	type CheckRecord,
	type Decider,
	defaultConfig,
	Lens,
	type MelianConfig,
	Revision,
	type Verdict,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	decisionExtension,
	type Harness,
	type Message,
	openHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FindingsDocument } from "../src/findings.ts";
import { commit, createRepository, gitIn, lines, removeRepository } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";
const checks: CheckRecord[] = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
	{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
];
const numbered = (count: number, label: string) =>
	lines(...Array.from({ length: count }, (_, index) => `${label} ${index + 1}`));

let repo: string;
let fake: FakeModels;
let harness: Harness;
let config: MelianConfig;
let lenses: Lens[];
let base: string;
let answers: Record<string, string>;

beforeEach(async () => {
	repo = createRepository();
	base = commit(repo, { "src/a.ts": numbered(20, "a"), "src/b.ts": numbered(20, "b") });
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	// The correctness lens may run quick, on the medium tier, so triage can put it below its default.
	const route = { model: `${heavy.provider}/${heavy.modelId}` };
	config = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: { heavy: route, medium: route },
		lenses: { correctness: { level: { floor: "quick" } } },
	};
	answers = {};
	const decider: Decider = {
		name: "rounds-test",
		calibrated: true,
		decide: async (request) => ({
			answers: request.questions.map(({ id }) => ({
				question: id,
				distribution: { [answers[id] ?? "careful"]: 1 },
			})),
		}),
	};
	const registry = createReviewRegistry();
	registry.install(decisionExtension(decider));
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	lenses = await Lens.load(repo, { kind: "revision", commit: base }, ["src/a.ts"]);
	deciderOf = decider;
});

let deciderOf: Decider;

afterEach(async () => {
	await harness.close(context);
	removeRepository(repo);
});

type Reply = ReturnType<typeof fauxAssistantMessage>;

const report = (file: string, line: number) =>
	fauxAssistantMessage(
		fauxToolCall("report_finding", {
			file,
			line,
			rule: "null-dereference",
			severity: "P1",
			explanation: { what: `${file} ${line} reads a missing value.`, why: "The change made it.", fix: "Guard it." },
			failureScenario: "Calling it with no value throws a TypeError.",
			evidence: [{ file, line, role: "cause" }],
		}),
		{ stopReason: "toolUse" },
	);

async function review(
	options: { readonly correctness?: Reply[]; readonly contracts?: Reply[]; readonly decide?: boolean } = {},
): Promise<{ verdict: Verdict; requests: Record<string, Message[][]>; key: string }> {
	const requests = scriptConversations(fake, [
		{ match: correctness, replies: options.correctness ?? [fauxAssistantMessage("Done.")] },
		{ match: contracts, replies: options.contracts ?? [fauxAssistantMessage("Done.")] },
	]);
	const changeset = await Changeset.resolve(repo, `${base}..feature`);
	let verdict: Verdict;
	try {
		({ verdict } = await reviewChangeset({
			harness,
			changeset,
			config,
			lenses,
			standards: [{ path: "AGENTS.md", content: "Be careful." }],
			models: fake.review,
			checks,
			...(options.decide === true ? { decider: deciderOf } : {}),
		}));
	} catch (error) {
		if ((error as { verdict?: Verdict }).verdict === undefined) throw error;
		verdict = (error as { verdict: Verdict }).verdict;
	}
	return { verdict, requests, key: Revision.key(changeset.revision) };
}

const promptOf = (requests: Record<string, Message[][]>, lens: string) =>
	(requests[lens]?.[0] ?? [])
		.filter((message) => message.role === "user")
		.map(textOf)
		.join("\n");
const lensRecord = (verdict: Verdict, name: string) =>
	[...(verdict.ran ?? []), ...verdict.notRun].filter((check) => check.name === `lens.${name}`);

describe("a delta round", () => {
	// A new file beside each change keeps a later fix well under half the diff, so coverage carries.
	const first = { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n"), "src/c.ts": numbered(20, "c") };

	it("keeps a carried finding through a repeat review of its head, which attaches and spends nothing", async () => {
		commit(repo, first);
		const one = await review({ correctness: [report("src/a.ts", 3), fauxAssistantMessage("Done.")] });
		const [id] = one.verdict.findings.block.map((finding) => finding.id);
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const two = await review();
		expect(two.verdict.findings.block.map((finding) => finding.id)).toEqual([id]);
		const calls = fake.provider.state.callCount;
		const again = await review();
		expect(fake.provider.state.callCount).toBe(calls);
		expect(again.verdict.findings.block.map((finding) => finding.id)).toEqual([id]);
		const state = (await harness.snapshot(FindingsDocument, (await harness.root(context)).id, context))!;
		expect(Object.keys(state.items[id!]!.sightings[two.key]!)).toEqual([
			expect.stringMatching(/^carried\/lens\.correctness@/),
		]);
		expect(lensRecord(again.verdict, "correctness")).toEqual(lensRecord(two.verdict, "correctness"));
	});

	it("has a lens whose finding the move lost review the whole diff, while another reviews the delta", async () => {
		commit(repo, { ...first, "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		await review({ correctness: [report("src/b.ts", 9), fauxAssistantMessage("Done.")] });
		gitIn(repo, "rm", "--quiet", "src/b.ts");
		commit(repo, {});
		const { requests } = await review();
		expect(promptOf(requests, correctness)).not.toContain("## The change under review");
		expect(promptOf(requests, contracts)).toContain("## The change under review");
	});

	it.each([
		["quick", "careful"],
		["deep", "deep"],
	])("runs a lens triage put at %s last round at %s, the higher of that and its default", async (last, now) => {
		commit(repo, first);
		answers = { correctness: last };
		const one = await review({ decide: true });
		expect(lensRecord(one.verdict, "correctness")[0]).toMatchObject({ status: "ran", level: last });
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		answers = { correctness: "quick" };
		const two = await review({ decide: true });
		expect(promptOf(two.requests, correctness)).toContain("## The change under review");
		expect(lensRecord(two.verdict, "correctness")[0]).toMatchObject({ status: "ran", level: now });
	});
});
