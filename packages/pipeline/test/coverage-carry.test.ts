import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Changeset,
	type CheckRecord,
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
	type Harness,
	type Message,
	openHarness,
	openSqliteStorage,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
	textOf,
	type VerifierScript,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FindingsDocument } from "../src/findings.ts";
import { verifierMarker } from "../src/verification-instructions.ts";
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

const report = (overrides: Record<string, unknown> = {}) =>
	fauxAssistantMessage(
		fauxToolCall("report_finding", {
			file: "src/a.ts",
			line: 3,
			rule: "null-dereference",
			severity: "P1",
			explanation: { what: "A 3 reads a missing value.", why: "The change made it.", fix: "Guard it." },
			failureScenario: "Calling it with no value throws a TypeError.",
			evidence: [{ file: "src/a.ts", line: 3, role: "cause" }],
			...overrides,
		}),
		{ stopReason: "toolUse" },
	);

async function review(
	options: {
		readonly correctness?: Reply[];
		readonly contracts?: Reply[];
		readonly verifier?: VerifierScript;
		readonly cold?: boolean;
		readonly lenses?: Lens[];
	} = {},
): Promise<{ verdict: Verdict; requests: Record<string, Message[][]>; key: string }> {
	const requests = scriptConversations(
		fake,
		[
			{ match: correctness, replies: options.correctness ?? [fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: options.contracts ?? [fauxAssistantMessage("Done.")] },
		],
		options.verifier ?? {},
	);
	const changeset = await Changeset.resolve(repo, `${base}..feature`);
	let verdict: Verdict;
	try {
		({ verdict } = await reviewChangeset({
			harness,
			changeset,
			config,
			lenses: options.lenses ?? lenses,
			standards: [{ path: "AGENTS.md", content: "Be careful." }],
			models: fake.review,
			checks,
			...(options.cold === true ? { cold: true } : {}),
		}));
	} catch (error) {
		if ((error as { verdict?: Verdict }).verdict === undefined) throw error;
		verdict = (error as { verdict: Verdict }).verdict;
	}
	return { verdict, requests, key: Revision.key(changeset.revision) };
}

function firstPrompt(requests: Record<string, Message[][]>, lens: string): string {
	return (requests[lens]?.[0] ?? [])
		.filter((message) => message.role === "user")
		.map(textOf)
		.join("\n");
}

async function carriedAt(key: string) {
	const state = (await harness.snapshot(FindingsDocument, (await harness.root(context)).id, context))!;
	return Object.entries(state.items).flatMap(([id, record]) =>
		Object.entries(record.sightings[key] ?? {})
			.filter(([producer]) => producer.startsWith("carried/"))
			.map(([producer, sighting]) => ({
				id,
				producer,
				mark: record.carried?.[key]?.[producer],
				line: sighting.locations[0]!.physicalLocation.region.startLine,
				verified: record.verifications?.[key]?.[producer] !== undefined,
			})),
	);
}

// The findings the verifier was asked to judge this round, by the claims its first request named.
const judged = (requests: Record<string, Message[][]>) =>
	[...systemPromptOf(requests[verifierMarker]?.[0] ?? []).matchAll(/Claim c[1-9][0-9]* finding ([0-9a-f]+)/g)].map(
		(match) => match[1],
	);

const blockIds = (verdict: Verdict) => verdict.findings.block.map((finding) => finding.id);
const allIds = (verdict: Verdict) =>
	[...verdict.findings.block, ...verdict.findings.acknowledge, ...verdict.findings.advisory].map(
		(finding) => finding.id,
	);

describe("the carry", () => {
	async function firstRound() {
		// A new file beside the defect keeps each later fix well under half the diff, so its coverage carries.
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n"), "src/c.ts": numbered(20, "c") });
		const first = await review({ correctness: [report(), fauxAssistantMessage("Done.")] });
		expect(first.verdict.findings.block).toHaveLength(1);
		return first.verdict.findings.block[0]!.id;
	}

	it("keeps a finding on a line the fix left alone, with its verification, and hands it to its lens", async () => {
		const id = await firstRound();
		commit(repo, {
			"src/a.ts": lines("top", ...numbered(20, "a").replace("a 3\n", "A 3\n").trimEnd().split("\n")),
			"src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n"),
		});
		const { verdict, requests, key } = await review();
		expect(blockIds(verdict)).toEqual([id]);
		expect(await carriedAt(key)).toEqual([
			{
				id,
				producer: expect.stringMatching(/^carried\/lens\.correctness@/),
				mark: { from: "r1" },
				line: 4,
				verified: true,
			},
		]);
		expect(firstPrompt(requests, correctness)).toContain(
			"## Findings earlier rounds reported\n\nEarlier rounds of this review reported the findings below, at this head's lines. Each line gives the finding's ID, severity, rule, and file with its first and last lines. For each, if the code still has the defect, report it again with report_finding at the same file, lines, and rule, with its own failure scenario and evidence. If the change since fixed it, or the code shows it is not a defect, report it with refuted set to its ID, at the same file, lines, and rule, with a failureScenario saying why it cannot fail and evidence holding the code that prevents it; a refutation goes to the verifier. A finding you leave unanswered stays in the review as reported.\n\n<untrusted-",
		);
		expect(firstPrompt(requests, correctness)).toMatch(
			new RegExp(
				`label="findings">\\n${id} P1 null-dereference at src/a\\.ts:4-4: A 3 reads a missing value\\.\\n</untrusted-`,
			),
		);
		expect(requests[verifierMarker] ?? []).toEqual([]);
	});

	it("marks a finding whose lines the fix changed, places it after the hunk and has the verifier judge it again", async () => {
		const id = await firstRound();
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3 again\n") });
		const { verdict, requests, key } = await review();
		expect(await carriedAt(key)).toEqual([
			{
				id,
				producer: expect.stringMatching(/^carried\/lens\.correctness@/),
				mark: { from: "r1", changed: true },
				line: 4,
				verified: true,
			},
		]);
		expect(judged(requests)).toEqual([id]);
		// Its new line is base code, so its cause is pre-existing now, but it stays in the verdict.
		expect(allIds(verdict)).toEqual([id]);
	});

	it("keeps the stricter severity when the lens restates a carried finding lower", async () => {
		const id = await firstRound();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const { verdict } = await review({ correctness: [report({ severity: "P2" }), fauxAssistantMessage("Done.")] });
		expect(blockIds(verdict)).toEqual([id]);
		expect(verdict.findings.block[0]!.properties.severity).toBe("P1");
	});

	it("sends a lens's refutation of a carried finding to the verifier, which decides it", async () => {
		const id = await firstRound();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const { verdict, requests } = await review({
			correctness: [report({ refuted: id }), fauxAssistantMessage("Done.")],
			verifier: { [id]: "confirmed" },
		});
		expect(judged(requests)).toEqual([id]);
		expect(blockIds(verdict)).toEqual([id]);
	});

	it("lowers nothing on a refutation at a level that does not verify", async () => {
		const quiet = lenses.map((lens) =>
			lens.name === "correctness"
				? Lens.from({
						...lens.toJSON(),
						levels: { ...lens.levels, careful: { ...lens.levels.careful, verify: false } },
					})
				: lens,
		);
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n"), "src/c.ts": numbered(20, "c") });
		const first = await review({ lenses: quiet, correctness: [report(), fauxAssistantMessage("Done.")] });
		const [id] = allIds(first.verdict);
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const { verdict, requests } = await review({
			lenses: quiet,
			correctness: [report({ refuted: id }), fauxAssistantMessage("Done.")],
		});
		expect(requests[verifierMarker] ?? []).toEqual([]);
		expect(allIds(verdict)).toEqual([id]);
	});

	it("keeps one carried/ prefix and the first round across heads", async () => {
		const id = await firstRound();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		await review();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n").replace("b 11\n", "B 11\n") });
		const { key } = await review();
		const carried = await carriedAt(key);
		expect(carried.map(({ producer }) => producer.match(/carried\//g)?.length)).toEqual([1]);
		expect(carried[0]).toMatchObject({ id, mark: { from: "r1" } });
	});

	it("deletes the carried sightings under --cold, which reviews the whole diff from nothing", async () => {
		await firstRound();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const { key } = await review();
		expect(await carriedAt(key)).toHaveLength(1);
		const cold = await review({ cold: true });
		expect(await carriedAt(cold.key)).toEqual([]);
		expect(cold.verdict.findings.block).toEqual([]);
	});
});

describe("a store main wrote at version 10 of the findings document", () => {
	const fixtures = fileURLToPath(new URL("./fixtures/findings-v10-main/", import.meta.url));
	const recorded = JSON.parse(readFileSync(join(fixtures, "recorded.json"), "utf8")) as {
		key: string;
		base: string;
		finding: string;
	};

	it("reads main's finding, and carries it to the next head once a round records coverage", async () => {
		const clone = createRepository();
		try {
			gitIn(
				clone,
				"fetch",
				"--quiet",
				"--update-head-ok",
				join(fixtures, "repo.bundle"),
				"refs/heads/*:refs/heads/*",
			);
			gitIn(clone, "checkout", "--quiet", "feature");
			const path = join(clone, "store.sqlite");
			copyFileSync(join(fixtures, "main.sqlite"), path);
			const reopened = await openHarness(await openSqliteStorage(path), {
				models: fake.models,
				registry: createReviewRegistry(),
				settings: { retry: { enabled: false } },
			});
			try {
				const at = async (range: string, replies: Reply[]) => {
					scriptConversations(fake, [
						{ match: correctness, replies },
						{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
					]);
					const changeset = await Changeset.resolve(clone, range);
					const { verdict } = await reviewChangeset({
						harness: reopened,
						changeset,
						config,
						lenses: await Lens.load(clone, { kind: "revision", commit: recorded.base }, ["src/a.ts"]),
						standards: [{ path: "AGENTS.md", content: "Be careful." }],
						models: fake.review,
						checks,
					});
					return { verdict, key: Revision.key(changeset.revision) };
				};
				// The prompt now names each file's modes, so the upgraded review runs its lenses again, and the lens reports
				// main's finding again, under the producer main stored it under.
				const upgraded = await at(`${recorded.base}..feature`, [report(), fauxAssistantMessage("Done.")]);
				expect(upgraded.key).toBe(recorded.key);
				expect(blockIds(upgraded.verdict)).toEqual([recorded.finding]);
				commit(clone, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
				const next = await at(`${recorded.base}..feature`, [fauxAssistantMessage("Done.")]);
				expect(blockIds(next.verdict)).toEqual([recorded.finding]);
				const state = (await reopened.snapshot(FindingsDocument, (await reopened.root(context)).id, context))!;
				expect(Object.keys(state.items[recorded.finding]!.carried?.[next.key] ?? {})).toEqual([
					expect.stringMatching(/^carried\/lens\.correctness@/),
				]);
			} finally {
				await reopened.close(context);
			}
		} finally {
			removeRepository(clone);
		}
	});
});

describe("rounds over the ledger, end to end", () => {
	async function defectAt(line = 3) {
		commit(repo, {
			"src/a.ts": numbered(20, "a").replace(`a ${line}\n`, `A ${line}\n`),
			"src/c.ts": numbered(20, "c"),
		});
		const first = await review({
			correctness: [
				report({ line, evidence: [{ file: "src/a.ts", line, role: "cause" }] }),
				fauxAssistantMessage("Done."),
			],
		});
		return first.verdict.findings.block[0]!.id;
	}

	it("lets a fix resolve a prior finding: its lens refutes it, the verifier agrees, and the review passes", async () => {
		const id = await defectAt();
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3 guarded\n"), "src/c.ts": numbered(20, "c") });
		const { verdict } = await review({
			correctness: [report({ refuted: id }), fauxAssistantMessage("Done.")],
			verifier: {
				[id]: {
					verdict: "refuted",
					reason: "The guard on line 3 returns before the read.",
					evidence: [{ file: "src/a.ts", line: 3, role: "cause" }],
				},
			},
		});
		expect(blockIds(verdict)).not.toContain(id);
		expect(verdict.status).toBe("passed");
	});

	it("keeps the prior finding and adds a new defect the fix brought in", async () => {
		const id = await defectAt();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const { verdict } = await review({
			correctness: [
				report({ file: "src/b.ts", line: 9, evidence: [{ file: "src/b.ts", line: 9, role: "cause" }] }),
				fauxAssistantMessage("Done."),
			],
		});
		expect(blockIds(verdict)).toHaveLength(2);
		expect(blockIds(verdict)).toContain(id);
	});

	it("leaves a defect in code no round's lens reported: the ledger reads complete, and only a cold round finds it", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n"), "src/c.ts": numbered(20, "c") });
		const missed = await review();
		expect(missed.verdict.status).toBe("passed");
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const delta = await review();
		expect(delta.verdict.status).toBe("passed");
		expect(firstPrompt(delta.requests, correctness)).toContain("## The change under review");
		const cold = await review({ cold: true, correctness: [report(), fauxAssistantMessage("Done.")] });
		expect(firstPrompt(cold.requests, correctness)).not.toContain("## The change under review");
		expect(cold.verdict.findings.block).toHaveLength(1);
	});

	it("shows a delta's lens the earlier hunks as context within the cap, and names those the cap left out", async () => {
		commit(repo, { "src/a.ts": numbered(20, "a").replace("a 3\n", "A 3\n"), "src/c.ts": numbered(20, "c") });
		await review();
		commit(repo, { "src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n") });
		const near = await review();
		const [, context] = firstPrompt(near.requests, correctness).split("## Context");
		expect(context).toContain("+A 3");
		commit(repo, {
			"src/b.ts": numbered(20, "b").replace("b 9\n", "B 9\n").replace("b 10\n", "B 10\n"),
			"src/a.ts": lines(
				...Array.from({ length: 6000 }, (_, index) => `export const value${index} = "${"x".repeat(30)}";`),
			),
		});
		const far = await review({ cold: true });
		expect(firstPrompt(far.requests, correctness)).toContain("These hunks were left out for size");
	});
});
