import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, ComparisonError, defaultConfig, ExternalFinding, Finding } from "@melian-agent/core";
import {
	CompareError,
	CompareHarness,
	backgroundContext as context,
	createMemoryStorage,
	FileImporter,
	type ImportedSource,
	maxReviewerFileBytes,
	openSqliteStorage,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
async function storeReview(harness: CompareHarness, reviewFindings: readonly Finding[] = findings): Promise<void> {
	const verdict = new Adjudication({
		findings: reviewFindings,
		manifest: [],
		checks: [],
		config: defaultConfig,
	}).adjudicate();
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		const document = await tx.doc(VerdictDocument, root.id);
		document.verdicts = { ...document.verdicts, [revisionKey(revision)]: verdict.toJSON() };
	}, context);
}

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
	it("reads an absent comparison and distinguishes an unreviewed base at a reviewed head", async () => {
		const harness = await memoryHarness();
		expect(await harness.read(revision)).toBeUndefined();
		await storeReview(harness);
		expect(await harness.reviewed(revision)).toBe(true);
		expect(await harness.reviewed({ ...revision, base: "c".repeat(40) })).toBe(false);
		expect(await harness.read(revision)).toBeUndefined();
	});

	it("closes storage after a cancelled open", async () => {
		const storage = createMemoryStorage();
		const controller = new AbortController();
		controller.abort();
		const cancelled = { abortSignal: controller.signal, value: () => undefined, toString: () => "cancelled" };
		await expect(CompareHarness.open(storage, createFakeModels().review, cancelled)).rejects.toThrow();
		await expect(storage.mintId()).rejects.toThrow("MemoryStorage is closed");
	});

	it("preserves an open failure when closing storage also fails", async () => {
		const storage = createMemoryStorage();
		const controller = new AbortController();
		controller.abort();
		const cancelled = { abortSignal: controller.signal, value: () => undefined, toString: () => "cancelled" };
		const closeFailure = new Error("close failed");
		const close = vi.spyOn(storage, "close").mockRejectedValueOnce(closeFailure);
		try {
			await expect(CompareHarness.open(storage, createFakeModels().review, cancelled)).rejects.toBe(
				controller.signal.reason,
			);
			expect(close).toHaveBeenCalledExactlyOnceWith(context);
		} finally {
			close.mockRestore();
			await storage.close(context);
		}
	});

	it("refuses to compare a revision Melian has not reviewed, and writes nothing", async () => {
		const harness = await memoryHarness();
		expect(await harness.reviewed(revision)).toBe(false);

		const refused = harness.importFindings(
			revision,
			[{ source: "file:codex.json", imported: { findings: [], skippedBodies: 0 } }],
			"t",
		);

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
			[{ source: "file:codex.json", imported: { findings: [near, far], skippedBodies: 0 } }],
			"t",
		);

		expect(comparison.melianFindings()).toEqual(findings.map((finding) => finding.id));
		expect(comparison.effectiveMatches()).toEqual([{ external: near.id, melian: findings[0]!.id, kind: "site" }]);
		expect(comparison.externalOnly().map((group) => group.external.map((each) => each.id))).toEqual([[far.id]]);
		expect(comparison.melianOnly()).toEqual([findings[1]!.id]);
		expect((await harness.read(revision))?.toJSON()).toEqual(comparison.toJSON());
		expect(await harness.read({ ...revision, base: "c".repeat(40) })).toBeUndefined();
	});

	it("imports both file sources in one call and stores both findings and source records", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		const sources: ImportedSource[] = [];
		for (const [name, reviewer, line] of [
			["codex.json", "codex", 12],
			["claude.json", "claude-code", 40],
		] as const) {
			writeFileSync(
				join(directory, name),
				JSON.stringify({
					reviewer: { name: reviewer },
					findings: [{ ref: "1", file: "src/run.ts", line, title: `eval at ${line}`, body: "eval runs input" }],
				}),
			);
			const importer = await FileImporter.open(name, { cwd: directory, repoRoot: directory });
			sources.push({ source: importer.source, imported: await importer.import() });
		}
		const external = sources.map((source) => source.imported.findings[0]!);

		const comparison = await harness.importFindings(revision, sources, "t");

		expect(comparison.externalFindings().map((finding) => finding.toJSON())).toEqual(
			expect.arrayContaining(external.map((finding) => finding.toJSON())),
		);
		expect(comparison.externalFindings()).toHaveLength(2);
		expect(comparison.effectiveMatches()).toEqual(
			expect.arrayContaining([
				{ external: external[0]!.id, melian: findings[0]!.id, kind: "site" },
				{ external: external[1]!.id, melian: findings[1]!.id, kind: "site" },
			]),
		);
		expect(comparison.importsBySource()).toEqual({
			"file:codex.json": { at: "t", ids: [external[0]!.id], skippedBodies: 0 },
			"file:claude.json": { at: "t", ids: [external[1]!.id], skippedBodies: 0 },
		});
		expect((await harness.read(revision))?.toJSON()).toEqual(comparison.toJSON());
	});

	it("compares a version 5 verdict without changing its plan, run details or walkthrough state", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		const root = await harness.harness.root(context);
		const key = revisionKey(revision);
		await root.commit(async (tx) => {
			const document = await tx.doc(VerdictDocument, root.id);
			document.provenance = {
				[key]: {
					kind: "range",
					policy: "config",
					manifest: [],
					lenses: [],
					plan: {
						tiers: [
							{ tier: "light", status: "routed", models: [{ model: "fake/scripted", credential: "test-key" }] },
						],
						lenses: [],
					},
				},
			};
			document.decisions = { [key]: { task: 1, findingsVersion: 2 } };
			document.details = { [key]: { policy: "config", manifest: [], lenses: [], standards: ["AGENTS.md"] } };
			document.walkthroughs = { [key]: { summary: "Changes the runner.", files: [] } };
			document.walkthroughNotes = { [key]: "A previous attempt failed." };
			document.walkthroughAttempts = { [key]: 1 };
		}, context);
		const before = await harness.harness.snapshot(VerdictDocument, root.id, context);
		const near = codex(13, 0);

		expect(await harness.reviewed(revision)).toBe(true);
		const comparison = await harness.importFindings(
			revision,
			[{ source: "file:codex.json", imported: { findings: [near], skippedBodies: 0 } }],
			"t",
		);
		const pair = { external: near.id, melian: findings[0]!.id };
		await harness.unmatch(revision, pair, { by: "M", at: "t2" });
		await harness.match(revision, pair, { by: "M", at: "t3" });

		expect(comparison.effectiveMatches()).toEqual([{ ...pair, kind: "site" }]);
		expect(await harness.harness.snapshot(VerdictDocument, root.id, context)).toEqual(before);
	});

	it("hand-matches against a replacement verdict and refuses a finding it no longer holds", async () => {
		const harness = await memoryHarness();
		const first = findings[0]!;
		const second = findings[1]!;
		const far = codex(90, 0);
		const sources = [{ source: "file:codex.json", imported: { findings: [far], skippedBodies: 0 } }];
		await storeReview(harness, [first]);
		await harness.importFindings(revision, sources, "t1");
		await storeReview(harness, [second]);
		const pair = { external: far.id, melian: second.id };
		const hand = { by: "Maintainer <m@example.com>", at: "t2" };

		const matched = await harness.match(revision, pair, hand);

		expect(matched.melianFindings()).toEqual([second.id]);
		expect(matched.effectiveMatches()).toEqual([{ ...pair, kind: "hand", ...hand }]);
		expect((await harness.read(revision))?.toJSON()).toEqual(matched.toJSON());
		const again = await harness.importFindings(revision, sources, "t3");
		expect(again.effectiveMatches()).toEqual(matched.effectiveMatches());
		const refused = harness.match(revision, { external: far.id, melian: first.id }, hand);
		await expect(refused).rejects.toThrow(ComparisonError);
		await expect(refused).rejects.toMatchObject({ code: "unknownMelian" });
		expect((await harness.read(revision))?.toJSON()).toEqual(again.toJSON());
	});

	it("keeps a hand match and an unmatch across a reopen and a re-import", async () => {
		const path = join(directory, "changeset.sqlite");
		const near = codex(13, 0);
		const far = codex(90, 1);
		const first = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review);
		open.push(first);
		await storeReview(first);
		await first.importFindings(
			revision,
			[{ source: "file:codex.json", imported: { findings: [near, far], skippedBodies: 0 } }],
			"t1",
		);
		const hand = { by: "Maintainer <m@example.com>", at: "t2" };
		await first.unmatch(revision, { external: near.id, melian: findings[0]!.id }, hand);
		await first.match(revision, { external: far.id, melian: findings[1]!.id }, hand);
		await first.close(context);

		const second = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review);
		open.push(second);
		const again = await second.importFindings(
			revision,
			[{ source: "file:codex.json", imported: { findings: [near, far], skippedBodies: 0 } }],
			"t3",
		);

		expect(again.effectiveMatches()).toEqual([{ external: far.id, melian: findings[1]!.id, kind: "hand", ...hand }]);
		expect(again.toJSON().unmatches).toEqual([{ external: near.id, melian: findings[0]!.id, ...hand }]);
		expect(again.externalFindings()).toHaveLength(2);
	});

	it("refuses a hand match naming a finding the comparison does not hold, and changes nothing", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		await harness.importFindings(
			revision,
			[{ source: "file:codex.json", imported: { findings: [codex(13, 0)], skippedBodies: 0 } }],
			"t",
		);
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

	it.each(["real", "symlinked"])(
		"keeps the source and finding IDs through a symlinked directory with a %s repository root",
		async (kind) => {
			const root = repo();
			const linked = join(directory, "repo-link");
			symlinkSync(root, linked, "dir");
			writeFileSync(
				join(root, "reviews/claude.json"),
				JSON.stringify({
					reviewer: { name: "claude-code" },
					findings: [
						{ ref: "1", file: "src/run.ts", line: 12, title: "eval", body: "eval runs input" },
						{ file: "src/run.ts", line: 40, title: "eval", body: "eval runs other input" },
					],
				}),
			);

			const throughLink = await FileImporter.open("claude.json", {
				cwd: join(linked, "reviews"),
				repoRoot: kind === "real" ? root : linked,
			});
			const first = await throughLink.import();
			const throughReal = await FileImporter.open("claude.json", { cwd: join(root, "reviews"), repoRoot: root });
			const second = await throughReal.import();

			expect(throughLink.source).toBe("file:reviews/claude.json");
			expect(throughReal.source).toBe(throughLink.source);
			expect(first.findings.map((finding) => finding.source)).toEqual([
				{ kind: "file", path: "reviews/claude.json", position: 0, ref: "1" },
				{ kind: "file", path: "reviews/claude.json", position: 1 },
			]);
			expect(first.findings).toHaveLength(2);
			expect(second.findings.map((finding) => finding.id)).toEqual(first.findings.map((finding) => finding.id));
		},
	);

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

	it("imports valid JSON at exactly maxReviewerFileBytes", async () => {
		const root = repo();
		const json = JSON.stringify({ reviewer: { name: "human" }, findings: [] });
		const text = json + " ".repeat(maxReviewerFileBytes - Buffer.byteLength(json));
		expect(Buffer.byteLength(text)).toBe(4_194_304);
		writeFileSync(join(root, "limit.json"), text);

		const importer = await FileImporter.open("limit.json", { cwd: root, repoRoot: root });

		expect(importer.source).toBe("file:limit.json");
		expect(await importer.import()).toEqual({ findings: [], skippedBodies: 0 });
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
