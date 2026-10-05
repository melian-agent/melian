import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, ComparisonError, defaultConfig, ExternalFinding, Finding } from "@melian-agent/core";
import {
	CompareError,
	CompareHarness,
	backgroundContext as context,
	createMemoryStorage,
	FileImporter,
	maxReviewerFileBytes,
	openSqliteStorage,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { ComparisonDocument } from "../src/compare.ts";

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
