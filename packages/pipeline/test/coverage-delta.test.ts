import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	Changeset,
	type CheckRecord,
	type CoverageSummary,
	defaultConfig,
	Lens,
	type MelianConfig,
	Revision,
	type StoredCoverageRecord,
	type Verdict,
} from "@melian-agent/core";
import {
	ChangePrompt,
	CoverageDocument,
	CoverageLedger,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
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
import { RoundsDocument } from "../src/rounds.ts";
import { commit, createRepository, gitIn, lines, removeRepository } from "./fixtures/repo.ts";
import { twoLensTiers, withBudget } from "./fixtures/review-scenario.ts";

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

beforeEach(async () => {
	repo = createRepository();
	base = commit(repo, { "src/a.ts": numbered(20, "a"), "src/b.ts": numbered(20, "b") });
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	config = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
	};
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	lenses = await Lens.load(repo, { kind: "revision", commit: base }, ["src/a.ts"]);
});

afterEach(async () => {
	await harness.close(context);
	removeRepository(repo);
});

type Reply = ReturnType<typeof fauxAssistantMessage>;

async function review(
	options: {
		readonly correctness?: Reply[];
		readonly contracts?: Reply[];
		readonly lenses?: Lens[];
		readonly config?: MelianConfig;
		readonly cold?: boolean;
	} = {},
): Promise<{
	verdict: Verdict;
	summary: CoverageSummary;
	record: StoredCoverageRecord;
	requests: Record<string, Message[][]>;
	round: string;
}> {
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
			config: options.config ?? config,
			lenses: options.lenses ?? lenses,
			standards: [{ path: "AGENTS.md", content: "Be careful." }],
			models: fake.review,
			checks,
			...(options.cold === true ? { cold: true } : {}),
		}));
	} catch (error) {
		verdict = (error as { verdict: Verdict }).verdict;
	}
	const root = (await harness.root(context)).id;
	const key = Revision.key(changeset.revision);
	const { summary } = await new CoverageLedger(harness, root).section(key, context);
	const round = (await harness.snapshot(RoundsDocument, root, context))!.current[key]!;
	const record = (await harness.snapshot(CoverageDocument, root, context))!.records[round]!;
	return { verdict, summary, record, requests, round };
}

// The first user turn a lens's conversation was sent: its change prompt.
function promptOf(requests: Record<string, Message[][]>, lens: string): string {
	const first = requests[lens]?.[0] ?? [];
	return first
		.filter((message) => message.role === "user")
		.map(textOf)
		.join("\n");
}

function checkOf(verdict: Verdict, name: string): CheckRecord | undefined {
	return [...(verdict.ran ?? []), ...verdict.notRun].find((check) => check.name === name);
}

function coverageCheckOf(verdict: Verdict): CheckRecord | undefined {
	return checkOf(verdict, "review.coverage");
}

const readCall = (path: string, startLine?: number) =>
	fauxAssistantMessage(fauxToolCall("read_file", { path, ...(startLine === undefined ? {} : { startLine }) }), {
		stopReason: "toolUse",
	});

describe("a round over the ledger", () => {
	it("covers the whole diff in the first round, and records review.coverage as ran", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const { verdict, summary, round } = await review();
		expect(round).toBe("r1");
		expect(summary.complete).toBe(true);
		expect(coverageCheckOf(verdict)).toEqual({ name: "review.coverage", status: "ran" });
		expect(verdict.status).toBe("passed");
	});

	it("reviews only the fix's hunks in the next round, with the rest as context, and passes when the ledger is whole", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		await review();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const { verdict, summary, record, requests } = await review();
		const prompt = promptOf(requests, correctness);
		const [underReview, context] = prompt.split("## Context");
		expect(underReview).toContain("## The change under review");
		expect(underReview).toContain("+B 9");
		expect(underReview).not.toContain("+A 3");
		expect(context).toContain("+A 3");
		expect(record.carriedFrom).toBe("r1");
		expect(summary).toEqual({ complete: true, rounds: ["r1", "r2"], gaps: [] });
		expect(verdict.status).toBe("passed");
	});

	it("skips with leave a lens with nothing uncovered", async () => {
		const narrowed = {
			...config,
			lenses: { contracts: { paths: ["src/a.ts"] } },
		} satisfies MelianConfig;
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		await review({ config: narrowed });
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const { verdict, requests } = await review({ config: narrowed });
		expect(checkOf(verdict, "lens.contracts")).toEqual({
			name: "lens.contracts",
			status: "skipped",
			reason: "nothing uncovered",
		});
		expect(requests[contracts]).toEqual([]);
		expect(verdict.status).toBe("passed");
	});

	it("leaves the review not reviewed when a lens ends, naming the gap in review.coverage", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		await review();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const ended = lenses.map((lens) => (lens.name === "correctness" ? withBudget(lens, { tokens: 1 }) : lens));
		const { verdict } = await review({
			lenses: ended,
			correctness: [readCall("src/b.ts"), fauxAssistantMessage("Done.")],
		});
		expect(verdict.status).toBe("not-reviewed");
		expect(coverageCheckOf(verdict)).toMatchObject({ status: "skipped" });
		expect(coverageCheckOf(verdict)?.reason).toContain(
			"coverage is incomplete: lens.correctness src/b.ts: lens ended at its budget in this round",
		);
	});

	it("reviews the whole diff from nothing under --cold", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		await review();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const { record, requests } = await review({ cold: true });
		expect(promptOf(requests, correctness)).not.toContain("## The change under review");
		expect(promptOf(requests, correctness)).toContain("+A 3");
		expect(record.voids).toEqual([{ reason: "a cold round reviews the whole diff from nothing" }]);
		expect(record.checks["lens.correctness"]!.covered.every((segment) => segment.round === undefined)).toBe(true);
	});

	it("attaches a repeat review of a decided head and spends nothing", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		const first = await review();
		const calls = fake.provider.state.callCount;
		const again = await review();
		expect(fake.provider.state.callCount).toBe(calls);
		expect(again.round).toBe(first.round);
		expect(again.verdict.status).toBe("passed");
	});

	it("runs a lens on a delta at the higher of its last level and its default", async () => {
		const deep = lenses.map((lens) => lens);
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n") });
		await review({ config: { ...config, lenses: { correctness: { level: { floor: "deep" } } } } });
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const { verdict } = await review({
			lenses: deep,
			config: { ...config, lenses: { correctness: { level: { floor: "deep" } } } },
		});
		expect(verdict.ran?.find((check) => check.name === "lens.correctness")?.level).toBe("deep");
	});
});

describe("the change prompt", () => {
	it("still delivers a small file's hunks beside a file over the limit, and names the hunks it left out", async () => {
		commit(repo, {
			"src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n"),
			"src/big.ts": lines(
				...Array.from({ length: 6000 }, (_, index) => `export const value${index} = "${"x".repeat(30)}";`),
			),
		});
		const changeset = await Changeset.resolve(repo, `${base}..feature`);
		const { text, cut, delivered } = new ChangePrompt(changeset, "n".repeat(24)).renderInput();
		expect(cut).toBe(true);
		expect(text).toContain("+A 3");
		expect(text).toContain("src/big.ts lines 1-6000");
		expect(delivered.hunks["src/a.ts"]).toEqual([0]);
		expect(delivered.hunks["src/big.ts"]).toBeUndefined();
		expect(delivered.omitted).toEqual(["src/big.ts"]);
	});

	it("names each file's modes, kinds, binary flag, symlink target and emptiness, so a file unit is delivered", async () => {
		chmodSync(join(repo, "src/b.ts"), 0o755);
		rmSync(join(repo, "src/a.ts"));
		symlinkSync("b.ts", join(repo, "src/a.ts"));
		commit(repo, { "empty.json": "" });
		const changeset = await Changeset.resolve(repo, `${base}..feature`);
		const prompt = new ChangePrompt(changeset, "n".repeat(24), await ChangePrompt.readTargets(changeset));
		const { text, delivered } = prompt.renderInput();
		expect(text).toContain("mode 100644 (file) -> 100755 (executable); text");
		expect(text).toContain("mode 100644 (file) -> 120000 (symlink); text; symlink target b.ts");
		expect(text).toContain("mode none (none) -> 100644 (file); text; empty file");
		for (const unit of changeset.revision.fileUnits())
			expect(delivered.fields[unit.path]).toEqual(expect.arrayContaining([...unit.fields]));
	});

	it("covers a file unit once its block names every field", async () => {
		chmodSync(join(repo, "src/b.ts"), 0o755);
		commit(repo, {});
		const { summary } = await review();
		expect(summary.complete).toBe(true);
	});
});
