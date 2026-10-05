import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Adjudication,
	Comparison,
	ComparisonError,
	ComparisonSet,
	defaultConfig,
	ExternalFinding,
	Finding,
} from "@melian-agent/core";
import {
	CompareError,
	CompareHarness,
	ComparisonReader,
	backgroundContext as context,
	createMemoryStorage,
	FileImporter,
	maxReviewerFileBytes,
	openSqliteStorage,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { ComparisonDocument } from "../src/compare.ts";
import { defineDoc, defineTask } from "../src/harness.ts";

const revision = { base: "a".repeat(40), head: "b".repeat(40) };

const evalAt = (startLine: number, snippet: string) =>
	Finding.create({
		rule: "no-eval",
		message: "eval runs request input",
		file: "src/run.ts",
		startLine,
		snippet,
		occurrence: 0,
		cause: "introduced",
		severity: "P1",
		explanation: { what: "eval", whyHere: "here", whatToDo: "parse" },
		source: { check: "lens.correctness", version: "1" },
	});

const findings = [evalAt(12, "eval(input)"), evalAt(40, "eval(other)")];

// Stores Melian's verdict of `revision`, as a review would, over these findings.
async function storeReview(harness: CompareHarness): Promise<void> {
	const verdict = new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate();
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		const document = await tx.doc(VerdictDocument, root.id);
		document.verdicts = { ...document.verdicts, [revisionKey(revision)]: verdict.toJSON() };
	}, context);
}

const imported = (...each: ExternalFinding[]) => ({ findings: each, skippedBodies: 0 });

function codex(line: number, position: number): ExternalFinding {
	return ExternalFinding.create({
		reviewer: { name: "codex" },
		file: "src/run.ts",
		line,
		title: `finding at ${line}`,
		body: "body",
		source: { kind: "file", path: "codex.json", position },
	});
}

let directory: string;
const open: CompareHarness[] = [];

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-compare-")));
});

afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
	rmSync(directory, { recursive: true, force: true });
});

async function memoryHarness(): Promise<CompareHarness> {
	const harness = await CompareHarness.open(createMemoryStorage(), createFakeModels().review);
	open.push(harness);
	return harness;
}

describe("CompareHarness", () => {
	it("refuses to compare a revision Melian has not reviewed, and writes nothing", async () => {
		const harness = await memoryHarness();
		expect(await harness.reviewed(revision)).toBe(false);

		const refused = harness.importFindings(revision, [{ source: "file:codex.json", imported: imported() }], "t");

		await expect(refused).rejects.toThrow(CompareError);
		await expect(refused).rejects.toMatchObject({ code: "notReviewed" });
		const root = await harness.harness.root(context);
		expect(await harness.harness.snapshot(ComparisonDocument, root.id, context)).toBeUndefined();
	});

	it("matches what it imports against the stored review, and records the comparison under the revision", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		const near = codex(13, 0);
		const far = codex(90, 1);

		const comparison = await harness.importFindings(
			revision,
			[{ source: "file:codex.json", imported: imported(near, far) }],
			"t",
		);

		expect(comparison.melianFindings()).toEqual(findings.map((finding) => finding.id));
		expect(comparison.effectiveMatches()).toEqual([{ external: near.id, melian: findings[0]!.id, kind: "site" }]);
		expect(comparison.externalOnly().map((group) => group.external.map((each) => each.id))).toEqual([[far.id]]);
		expect(comparison.melianOnly()).toEqual([findings[1]!.id]);
		expect((await harness.read(revision))?.toJSON()).toEqual(comparison.toJSON());
		expect(await harness.read({ ...revision, base: "c".repeat(40) })).toBeUndefined();
	});

	it("keeps a hand match and an unmatch across a reopen and a re-import", async () => {
		const path = join(directory, "changeset.sqlite");
		const near = codex(13, 0);
		const far = codex(90, 1);
		const first = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review);
		open.push(first);
		await storeReview(first);
		await first.importFindings(revision, [{ source: "file:codex.json", imported: imported(near, far) }], "t1");
		const hand = { by: "Maintainer <m@example.com>", at: "t2" };
		await first.unmatch(revision, { external: near.id, melian: findings[0]!.id }, hand);
		await first.match(revision, { external: far.id, melian: findings[1]!.id }, hand);
		await first.close(context);

		const second = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review);
		open.push(second);
		const again = await second.importFindings(
			revision,
			[{ source: "file:codex.json", imported: imported(near, far) }],
			"t3",
		);

		expect(again.effectiveMatches()).toEqual([{ external: far.id, melian: findings[1]!.id, kind: "hand", ...hand }]);
		expect(again.toJSON().unmatches).toEqual([{ external: near.id, melian: findings[0]!.id, ...hand }]);
		expect(again.externalFindings()).toHaveLength(2);
	});

	it("refuses a hand match naming a finding the comparison does not hold, and changes nothing", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		await harness.importFindings(revision, [{ source: "file:codex.json", imported: imported(codex(13, 0)) }], "t");
		const before = (await harness.read(revision))?.toJSON();

		const refused = harness.match(
			revision,
			{ external: "0".repeat(16), melian: findings[0]!.id },
			{ by: "M", at: "t" },
		);

		await expect(refused).rejects.toThrow(ComparisonError);
		expect((await harness.read(revision))?.toJSON()).toEqual(before);
	});
});

describe("FileImporter", () => {
	const repo = () => {
		const root = join(directory, "repo");
		mkdirSync(join(root, "reviews"), { recursive: true });
		return root;
	};

	it("reads the external-finding shape, naming the file relative to the repository", async () => {
		const root = repo();
		writeFileSync(
			join(root, "reviews/claude.json"),
			JSON.stringify({
				reviewer: { name: "claude-code" },
				findings: [{ ref: "1", file: "src/run.ts", line: 12, title: "eval", body: "eval runs input" }],
			}),
		);

		const importer = await FileImporter.open("claude.json", { cwd: join(root, "reviews"), repoRoot: root });
		const read = await importer.import();

		expect(importer.source).toBe("file:reviews/claude.json");
		expect(read.skippedBodies).toBe(0);
		expect(read.findings.map((finding) => finding.source)).toEqual([
			{ kind: "file", path: "reviews/claude.json", position: 0, ref: "1" },
		]);
	});

	it("reads Codex's review output, and names a file outside the repository by its absolute path", async () => {
		const root = repo();
		const outside = join(directory, "codex.json");
		writeFileSync(
			outside,
			JSON.stringify({
				verdict: "approve",
				summary: "Nothing.",
				findings: [
					{
						severity: "low",
						title: "t",
						body: "b",
						file: "src/run.ts",
						line_start: 2,
						line_end: 3,
						confidence: 0.5,
						recommendation: "",
					},
				],
				next_steps: [],
			}),
		);

		const importer = await FileImporter.open(outside, { cwd: root, repoRoot: root });

		expect(importer.source).toBe(`file:${outside}`);
		const [finding] = (await importer.import()).findings;
		expect(finding?.toJSON()).toMatchObject({ reviewer: { name: "codex" }, line: 2, endLine: 3, body: "b" });
	});

	it("refuses a missing file, one that is not JSON, and JSON in neither shape", async () => {
		const root = repo();
		writeFileSync(join(root, "broken.json"), "{ not json");
		writeFileSync(join(root, "wrong.json"), JSON.stringify({ findings: [] }));
		const options = { cwd: root, repoRoot: root };

		await expect(FileImporter.open("missing.json", options)).rejects.toMatchObject({
			code: "unreadable",
			message: expect.stringContaining("missing.json: no such file"),
		});
		await expect(FileImporter.open("broken.json", options)).rejects.toMatchObject({
			code: "unreadable",
			message: expect.stringContaining("broken.json: it is not JSON at position 2"),
		});
		await expect(FileImporter.open("wrong.json", options)).rejects.toMatchObject({ code: "invalidFile" });
		await expect(FileImporter.open("reviews", options)).rejects.toMatchObject({
			message: expect.stringContaining("not a file"),
		});
	});

	it("refuses a file larger than maxReviewerFileBytes without reading it", async () => {
		const root = repo();
		writeFileSync(join(root, "huge.json"), "");
		truncateSync(join(root, "huge.json"), maxReviewerFileBytes + 1);

		await expect(FileImporter.open("huge.json", { cwd: root, repoRoot: root })).rejects.toMatchObject({
			code: "unreadable",
			message: expect.stringContaining(`huge.json: it is larger than ${maxReviewerFileBytes} bytes`),
		});
	});
});

describe("comparison judgements", () => {
	it("records author, time and replacement history without changing the verdict", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		const root = await harness.harness.root(context);
		const before = await harness.harness.snapshot(VerdictDocument, root.id, context);
		await harness.importFindings(revision, [], "2026-10-05T00:00:00Z");
		const first = { verdict: "valid", by: "M", at: "2026-10-05T01:00:00Z" } as const;
		await harness.adjudicate(revision, findings[0]!.id, first);
		const second = { verdict: "noise", by: "N", at: "2026-10-05T02:00:00Z", golden: "correctness" } as const;
		await harness.adjudicate(revision, findings[0]!.id, second);
		expect((await harness.read(revision))?.adjudication(findings[0]!.id)).toEqual({
			current: second,
			history: [first],
		});
		expect(await harness.harness.snapshot(VerdictDocument, root.id, context)).toEqual(before);
	});
});

describe("all stored comparisons", () => {
	it("returns each revision with its review and first comparison time, without writing on read", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		await harness.importFindings({ ...revision, target: "main...feature" }, [], "2026-10-05T00:00:00Z");
		await harness.importFindings(revision, [], "2026-10-06T00:00:00Z");
		const entries = await harness.all("changeset");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.comparison.recordedAt()).toBe("2026-10-05T00:00:00Z");
		expect(entries[0]?.comparison.label()).toBe("main...feature");
		expect(entries[0]?.verdict?.all()).toHaveLength(2);
	});
});

describe("comparison review fixes", () => {
	it("discharges a first round's debt after a second review drops the finding", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		await harness.importFindings(revision, [], "2026-10-05T00:00:00Z");
		const debt = { verdict: "noise", by: "M", at: "2026-10-05T01:00:00Z", golden: "correctness" } as const;
		await harness.adjudicate(revision, findings[0]!.id, debt);
		const next = { ...revision, head: "c".repeat(40) };
		const root = await harness.harness.root(context);
		await root.commit(async (tx) => {
			const document = await tx.doc(VerdictDocument, root.id);
			document.verdicts = {
				...document.verdicts,
				[revisionKey(next)]: new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
					.adjudicate()
					.toJSON(),
			};
		}, context);
		await harness.importFindings(next, [], "2026-10-06T00:00:00Z");
		expect(new ComparisonSet(await harness.all("change")).backlog()).toHaveLength(1);
		const discharged = { ...debt, at: "2026-10-07T00:00:00Z", golden: "none" } as const;
		const round = await harness.adjudicate(next, findings[0]!.id, discharged);
		expect(round.head).toBe(revision.head);
		expect(round.adjudication(findings[0]!.id)).toEqual({ current: discharged, history: [debt] });
		expect(new ComparisonSet(await harness.all("change")).backlog()).toEqual([]);
	});

	it("chooses the newest round containing an ID and carries earlier debt forward", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		await harness.importFindings(revision, [], "2026-10-05T00:00:00Z");
		await harness.adjudicate(revision, findings[0]!.id, {
			verdict: "noise",
			by: "M",
			at: "2026-10-05T01:00:00Z",
			golden: "correctness",
		});
		const next = { ...revision, head: "c".repeat(40) };
		const root = await harness.harness.root(context);
		await root.commit(async (tx) => {
			const document = await tx.doc(VerdictDocument, root.id);
			document.verdicts = { ...document.verdicts, [revisionKey(next)]: document.verdicts[revisionKey(revision)]! };
		}, context);
		await harness.importFindings(next, [], "2026-10-06T00:00:00Z");
		const round = await harness.adjudicate(revision, findings[0]!.id, {
			verdict: "valid",
			by: "M",
			at: "2026-10-07T00:00:00Z",
		});
		expect(round.head).toBe(next.head);
		expect(round.adjudication(findings[0]!.id)?.current.golden).toBe("correctness");
		expect((await harness.read(revision))?.adjudication(findings[0]!.id)?.current.verdict).toBe("noise");
	});

	it("reads documents without committing or changing pending tasks", async () => {
		const storage = createMemoryStorage();
		const harness = await CompareHarness.open(storage, createFakeModels().review);
		open.push(harness);
		await storeReview(harness);
		await harness.importFindings(revision, [], "2026-10-05T00:00:00Z");
		const root = await harness.harness.root(context);
		const task = defineTask<Record<string, never>, { phase: "wait" }, Record<string, never>>({
			name: "test.pending",
			version: 1,
			initial: () => ({ phase: "wait" }),
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
			phases: {
				wait: async (_task, runtime, context) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: {} } }),
						context,
					);
				},
			},
		});
		const pending = await root.commit(
			(tx) => tx.createTask(task, {}, { ownership: { kind: "conversation" } }),
			context,
		);
		const before = await storage.task(pending, context);
		const commit = vi.spyOn(storage, "commit");
		const entries = await new ComparisonReader(storage).read("change");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.verdict?.all()).toHaveLength(2);
		expect(commit).not.toHaveBeenCalled();
		expect(await storage.task(pending, context)).toEqual(before);
		commit.mockRestore();
	});

	describe("documents of other versions", () => {
		type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
		type Tx = Parameters<Parameters<Awaited<ReturnType<CompareHarness["harness"]["root"]>>["commit"]>[0]>[0];
		const legacy = (kind: string, version: number) =>
			defineDoc<{ [key: string]: Json }>({
				kind,
				version,
				scope: "conversation",
				history: "rewindable",
				fork: "asOf",
				initial: () => ({}),
			});
		const oldEvidence = (value: unknown): unknown =>
			Array.isArray(value)
				? value.map(oldEvidence)
				: value !== null && typeof value === "object"
					? Object.fromEntries(
							Object.entries(value).map(([key, each]) => [
								key,
								key === "evidence" && Array.isArray(each)
									? (({ role: _, revision: __, ...first }) => first)(each[0] as Record<string, unknown>)
									: oldEvidence(each),
							]),
						)
					: value;

		async function readWith(write: (tx: Tx, id: string) => Promise<void>) {
			const storage = createMemoryStorage();
			const harness = await CompareHarness.open(storage, createFakeModels().review);
			open.push(harness);
			const root = await harness.harness.root(context);
			await root.commit((tx) => write(tx, root.id), context);
			return await new ComparisonReader(storage).read("change");
		}
		const storeComparison = async (tx: Tx, id: string) => {
			const document = await tx.doc(ComparisonDocument, id);
			document.comparisons = { [revisionKey(revision)]: Comparison.of(revision).toJSON() };
		};

		it("migrates a version 2 verdict document through the reader", async () => {
			const verdict = new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate();
			const entries = await readWith(async (tx, id) => {
				await storeComparison(tx, id);
				const old = await tx.doc(legacy(VerdictDocument.definition.kind, 2), id);
				old.verdicts = JSON.parse(JSON.stringify(oldEvidence({ [revisionKey(revision)]: verdict.toJSON() })));
			});
			expect(entries).toHaveLength(1);
			expect(entries[0]?.verdict?.all()).toHaveLength(2);
		});

		it("refuses a comparison document newer than this Melian", async () => {
			await expect(
				readWith(async (tx, id) => {
					(await tx.doc(legacy(ComparisonDocument.definition.kind, 99), id)).comparisons = {};
				}),
			).rejects.toMatchObject({ message: "comparison document has newer version 99" });
		});

		it("refuses a verdict document newer than this Melian", async () => {
			await expect(
				readWith(async (tx, id) => {
					await storeComparison(tx, id);
					(await tx.doc(legacy(VerdictDocument.definition.kind, 99), id)).verdicts = {};
				}),
			).rejects.toMatchObject({ message: "verdict document has newer version 99" });
		});
	});

	it("reads an empty storage without creating a root or a comparison document", async () => {
		const storage = createMemoryStorage();
		try {
			const commit = vi.spyOn(storage, "commit");
			expect(await new ComparisonReader(storage).read("change")).toEqual([]);
			expect(commit).not.toHaveBeenCalled();
			expect((await storage.scanConversations({}, 10, undefined, context)).items).toEqual([]);
		} finally {
			await storage.close(context);
		}
	});

	it.each(["codex", "claude-code"])("keeps %s participant identity in an empty file import", async (name) => {
		const path = join(directory, "empty.json");
		writeFileSync(
			path,
			JSON.stringify(
				name === "codex"
					? { verdict: "approve", summary: "Clean", findings: [], next_steps: [] }
					: { reviewer: { name, version: "2" }, findings: [] },
			),
		);
		const importer = await FileImporter.open(path, { cwd: directory, repoRoot: directory });
		expect(await importer.import()).toMatchObject({ findings: [], reviewers: [{ name }] });
	});
});
