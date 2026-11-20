import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Changeset,
	defaultConfig,
	GraphSnapshot,
	Lens,
	type LensPayload,
	type MelianConfig,
	MemoryRecordStore,
	type RecordEnvelope,
	ReviewCoverage,
	Revision,
	reviewPayloads,
} from "@melian-agent/core";
import {
	CallerContext,
	CoverageCache,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	GraphCache,
	type Harness,
	type Message,
	openHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { ImportedRecords } from "../src/imported-records.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";
const changedReturn = {
	file: "src/a.ts",
	line: 1,
	rule: "changed-return",
	severity: "P2",
	explanation: { what: "a is 2 now.", why: "This change rewrote it.", fix: "Restore 1." },
	failureScenario: "A caller that reads a expects 1 and gets 2.",
	evidence: [{ file: "src/a.ts", line: 1, role: "cause" }],
};
const checks = [
	{ name: "guardrails", status: "ran" as const },
	{ name: "static.biome", status: "ran" as const },
	{ name: "static.tsc", status: "ran" as const },
];
const parts = { tree: "a".repeat(40), version: "0.0.1", binary: "b".repeat(64), config: "c".repeat(64) };

let repo: string;
let opened: Harness[];

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

// A host of its own: a fake whose contracts lens reports `changedReturn` and whose lenses each read src/a.ts first, and
// a harness on a fresh store.
async function host() {
	const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }, { id: "light" }] });
	const harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	opened.push(harness);
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	return { fake, harness };
}

async function review(
	on: Awaited<ReturnType<typeof host>>,
	options: {
		readonly store?: MemoryRecordStore;
		readonly imported?: readonly RecordEnvelope[];
		readonly lenses?: readonly Lens[];
		readonly coverage?: string;
		// What contracts does: report `changedReturn`, the default; report nothing; or report it and then fail.
		readonly contracts?: "reports" | "quiet" | "fails";
	} = {},
) {
	const { fake, harness } = on;
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	const base: MelianConfig = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: { heavy: route("heavy"), light: route("light") },
	};
	const config =
		options.coverage === undefined
			? base
			: { ...base, static: { ...base.static, enola: { ...base.static.enola, enabled: true } } };
	const asked = new Set<string>();
	const answer = (name: string) => (messages: readonly Message[]) => {
		asked.add(name);
		if (!messages.some((message) => message.role === "toolResult"))
			return fauxAssistantMessage(fauxToolCall("read_file", { path: "src/a.ts" }), { stopReason: "toolUse" });
		const reported = messages.some(
			(message) => message.role === "toolResult" && JSON.stringify(message).includes("recorded"),
		);
		const mode = options.contracts ?? "reports";
		if (name === "contracts" && mode !== "quiet" && systemPromptOf(messages).includes(contracts) && !reported)
			return fauxAssistantMessage(fauxToolCall("report_finding", changedReturn), { stopReason: "toolUse" });
		if (name === "contracts" && mode === "fails")
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "The provider failed." });
		return fauxAssistantMessage("No findings.");
	};
	scriptConversations(fake, [
		{ match: correctness, replies: Array.from({ length: 4 }, () => answer("correctness")) },
		{ match: contracts, replies: Array.from({ length: 6 }, () => answer("contracts")) },
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const result = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses:
			options.lenses ?? (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts"),
		standards: [],
		models: fake.review,
		checks,
		...(options.coverage === undefined
			? {}
			: { callers: CallerContext.from({ groups: [], issues: [], notes: [], paths: [], parts }, options.coverage) }),
		...(options.store === undefined ? {} : { records: options.store }),
		...(options.imported === undefined ? {} : { imported: ImportedRecords.from(changeset.id, options.imported) }),
	});
	const root = (await harness.root(context)).id;
	const revision = Revision.key(changeset.revision);
	const entry = (await harness.snapshot(ReviewIndex, root, context))!.reviews[revision]!;
	const task = await harness.getTask(entry.task as Parameters<Harness["getTask"]>[0], context);
	const reused = (task!.input as { reused?: Record<string, { record?: string; task?: number }> }).reused ?? {};
	const details = (await harness.snapshot(VerdictDocument, root, context))!.details![revision]!;
	const stored = (await options.store?.list(changeset.id)) ?? [];
	return {
		verdict: result.verdict,
		asked: [...asked].sort(),
		reused: Object.fromEntries(Object.entries(reused).map(([key, copy]) => [key.split("@")[0], copy])),
		usage: Object.fromEntries(details.lenses.map(({ name, usage }) => [name, usage])),
		stored,
	};
}

// In a fixed order, since the store lists records in the order a review added them.
const lensesOf = (stored: readonly RecordEnvelope[]) =>
	stored.filter(({ kind }) => kind === "lens").sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
const named = (record: RecordEnvelope) => (record.payload as unknown as LensPayload).name;
const readOf = (stored: readonly RecordEnvelope[]) =>
	(stored.find(({ kind }) => kind === "round")!.payload as { read: { kind: string; key: string; id: string }[] }).read;

describe("a review that imports lens records", () => {
	it("asks no lens a record answers, keeps its findings, charges it nothing, and exports the records it stood on", async () => {
		const first = await review(await host(), { store: new MemoryRecordStore({ payloads: reviewPayloads }) });
		expect(first.asked).toEqual(["contracts", "correctness"]);
		expect(first.verdict.all().map((finding) => finding.toJSON().ruleId)).toEqual([
			expect.stringContaining("changed-return"),
		]);

		const second = await review(await host(), {
			store: new MemoryRecordStore({ payloads: reviewPayloads }),
			imported: lensesOf(first.stored),
		});
		expect(second.asked).toEqual([]);
		expect(Object.keys(second.reused).sort()).toEqual(["contracts", "correctness"]);
		expect(Object.values(second.reused).every((copy) => copy.record !== undefined && copy.task === undefined)).toBe(
			true,
		);
		expect(second.verdict.all().map((finding) => finding.toJSON())).toEqual(
			first.verdict.all().map((finding) => finding.toJSON()),
		);
		expect(second.usage).toEqual({ contracts: undefined, correctness: undefined });
		expect(lensesOf(second.stored)).toEqual(lensesOf(first.stored));
		expect(readOf(second.stored).filter(({ kind }) => kind === "lens")).toEqual(
			readOf(first.stored).filter(({ kind }) => kind === "lens"),
		);
	});

	it.each([
		["names another request", (record: RecordEnvelope) => ({ ...record, key: `${record.key.slice(0, -1)}0` })],
		[
			"ended at a budget",
			(record: RecordEnvelope) =>
				outcome(record, { budgetEnded: { budget: "tools", limit: 1, tokens: 1, tools: 1 } }),
		],
		["was capped at its findings budget", (record: RecordEnvelope) => outcome(record, { capped: 8 })],
		["probed", (record: RecordEnvelope) => payload(record, { probe: true })],
		["ran at another level", (record: RecordEnvelope) => payload(record, { level: "deep", check: null })],
		[
			"did not finish",
			(record: RecordEnvelope) => payload(record, { outcome: { status: "unanswered", reason: "failed" } }),
		],
	] as const)("asks the lens when the only record of its run %s", async (_, plant) => {
		const first = await review(await host(), { store: new MemoryRecordStore({ payloads: reviewPayloads }) });
		const records = lensesOf(first.stored).map((record) =>
			named(record) === "correctness" ? (plant(record) as RecordEnvelope) : record,
		);

		const second = await review(await host(), { imported: records });
		expect(second.asked).toEqual(["correctness"]);
		expect(Object.keys(second.reused)).toEqual(["contracts"]);
	});

	it("copies a lens from this host's own task rather than import it", async () => {
		const first = await review(await host(), { store: new MemoryRecordStore({ payloads: reviewPayloads }) });
		const own = await host();
		await review(own);
		// A changed contracts lens makes a new task, which copies correctness from the first.
		const lenses = (await Lens.builtins())
			.filter(({ name }) => name === "correctness" || name === "contracts")
			.map((lens) =>
				lens.name === "contracts"
					? Lens.from({ ...lens.toJSON(), instructions: `${lens.instructions} Look twice.` })
					: lens,
			);
		const again = await review(own, { imported: lensesOf(first.stored), lenses });
		expect(again.asked).toEqual(["contracts"]);
		expect(again.reused.correctness).toMatchObject({ task: expect.any(Number) });
		expect(again.reused.correctness?.record).toBeUndefined();
	});

	it("clears what this host's own failed run of a lens reported, in place of the imported run's findings", async () => {
		const first = await review(await host(), {
			store: new MemoryRecordStore({ payloads: reviewPayloads }),
			contracts: "quiet",
		});
		expect(first.verdict.all()).toHaveLength(0);
		const own = await host();
		await expect(review(own, { contracts: "fails" })).rejects.toThrow("lenses did not finish: contracts");
		// A changed correctness lens makes a new task, which cannot copy contracts's failed run, so it imports it.
		const lenses = (await Lens.builtins())
			.filter(({ name }) => name === "correctness" || name === "contracts")
			.map((lens) =>
				lens.name === "correctness"
					? Lens.from({ ...lens.toJSON(), instructions: `${lens.instructions} Look twice.` })
					: lens,
			);
		const again = await review(own, { imported: lensesOf(first.stored), lenses });
		expect(again.asked).toEqual(["correctness"]);
		expect(again.reused.contracts?.record).toBeDefined();
		expect(again.verdict.all()).toHaveLength(0);
	});

	it("leaves an imported lens out of the coverage this host records, since no conversation of its read a line", async () => {
		const cache = mkdtempSync(join(tmpdir(), "melian-imported-coverage-"));
		try {
			await (await GraphCache.open(cache)).store(
				GraphSnapshot.create(parts, {
					"facts.jsonl": "",
					"insights.json": "[]",
					"receipt.json": JSON.stringify({
						format_version: 1,
						enola_version: parts.version,
						snapshot_id: `sha256:${"d".repeat(64)}`,
					}),
				}),
			);
			const covered = async (result: Awaited<ReturnType<typeof review>>) => {
				const id = result.verdict.ran?.find(({ name }) => name === "lens.contracts")?.coverage?.review;
				const stored = await (await CoverageCache.open(cache)).read(parts, "review", { id });
				if (!(stored instanceof ReviewCoverage)) throw new Error("Review coverage missing");
				return stored.toJSON().lenses.map(({ name }) => name);
			};
			const first = await review(await host(), {
				store: new MemoryRecordStore({ payloads: reviewPayloads }),
				coverage: cache,
			});
			expect(await covered(first)).toEqual(["contracts", "correctness"]);

			const second = await review(await host(), {
				imported: lensesOf(first.stored).filter((record) => named(record) === "correctness"),
				coverage: cache,
			});
			expect(second.asked).toEqual(["contracts"]);
			expect(await covered(second)).toEqual(["contracts"]);
		} finally {
			rmSync(cache, { recursive: true, force: true });
		}
	});
});

function payload(record: RecordEnvelope, change: Partial<LensPayload>): RecordEnvelope {
	return {
		...record,
		payload: { ...(record.payload as unknown as LensPayload), ...change } as unknown as RecordEnvelope["payload"],
	};
}

function outcome(record: RecordEnvelope, change: Record<string, unknown>): RecordEnvelope {
	const { outcome: was } = record.payload as unknown as LensPayload;
	return payload(record, { outcome: { ...was, ...change } as LensPayload["outcome"] });
}
