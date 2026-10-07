import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
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
	DismissHarness,
	FileImporter,
	type ImportedSource,
	maxReviewerFileBytes,
	openSqliteStorage,
	revisionKey,
	type TaskId,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdjudicationTask, adjudicationInput, VerdictDocument } from "../src/adjudication.ts";
import { ComparisonDocument } from "../src/compare.ts";
import { FindingsDocument } from "../src/findings.ts";
import { defineDoc, defineTask } from "../src/harness.ts";
import { ReviewIndex } from "../src/review-index.ts";

vi.mock("node:fs/promises", { spy: true });

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
	it("keeps error causes optional and preserves a supplied cause", () => {
		const absent = new CompareError("notReviewed", "no review");
		expect(absent).toMatchObject({ name: "CompareError", code: "notReviewed", message: "no review" });
		expect(absent.cause).toBeUndefined();
		const cause = new Error("read failed");
		expect(new CompareError("unreadable", "cannot read", { cause }).cause).toBe(cause);
	});

	it("forwards the default and explicit close contexts to its harness", async () => {
		const harness = await memoryHarness();
		const close = vi.spyOn(harness.harness, "close");
		const supplied = {
			abortSignal: new AbortController().signal,
			value: () => undefined,
			toString: () => "supplied",
		};
		try {
			await harness.close();
			await harness.close(supplied);

			expect(close.mock.calls).toEqual([[context], [supplied]]);
		} finally {
			close.mockRestore();
		}
	});

	it("reads an absent comparison and distinguishes an unreviewed base at a reviewed head", async () => {
		const harness = await memoryHarness();
		expect(await harness.read(revision)).toBeUndefined();
		await storeReview(harness);
		expect(await harness.reviewed(revision)).toBe(true);
		expect(await harness.reviewed({ ...revision, base: "c".repeat(40) })).toBe(false);
		expect(await harness.read(revision)).toBeUndefined();
	});

	it.each(["changed findings", "missing task"])(
		"refuses a stored verdict with %s without changing an existing comparison",
		async (stale) => {
			const harness = await memoryHarness();
			await storeReview(harness);
			await harness.importFindings(revision, [], "before");
			const before = (await harness.read(revision))!.toJSON();
			const root = await harness.harness.root(context);
			const key = revisionKey(revision);
			await root.commit(async (tx) => {
				if (stale === "changed findings") {
					(await tx.doc(VerdictDocument, root.id)).decisions = { [key]: { task: 999, findingsVersion: 0 } };
					(await tx.doc(FindingsDocument, root.id)).versions[key] = 1;
				} else {
					(await tx.doc(ReviewIndex, root.id)).reviews[key] = {
						lenses: [],
						adjudication: { task: 999, input: JSON.stringify({ findingsVersion: 0 }) },
					};
				}
			}, context);

			expect(await harness.reviewed(revision)).toBe(false);
			await expect(harness.importFindings(revision, [], "after")).rejects.toMatchObject({ code: "notReviewed" });
			expect((await harness.read(revision))!.toJSON()).toEqual(before);
		},
	);

	describe("a verdict whose adjudication task is not the current decision", () => {
		async function reviewedWithTasks(path: string) {
			const deciding = await DismissHarness.open(await openSqliteStorage(path), createFakeModels().review);
			const { harness } = deciding;
			const root = await harness.root(context);
			const key = revisionKey(revision);
			const input = (findingsVersion: number) =>
				adjudicationInput({
					root: root.id,
					repoRoot: directory,
					...revision,
					policy: undefined,
					config: defaultConfig,
					manifest: [],
					checks: [],
					findingsVersion,
					allowSkip: [],
					producers: [],
					origin: { kind: "range" },
					lenses: [],
				});
			const create = (version: number) =>
				root.commit(
					(tx) => tx.createTask(AdjudicationTask, input(version), { ownership: { kind: "conversation" } }),
					context,
				);
			const point = (task: TaskId) =>
				root.commit(async (tx) => {
					const index = await tx.doc(ReviewIndex, root.id);
					index.reviews = {
						...index.reviews,
						[key]: { adjudication: { task, input: "{}" } },
					} as typeof index.reviews;
				}, context);
			const run = async (task: TaskId) => {
				harness.resume();
				return (await harness.waitForTask(task, context)).state;
			};
			return { deciding, root, key, create, point, run, input };
		}

		it("refuses one that ended superseded, which no decision record vouches for", async () => {
			const path = join(directory, "changeset.sqlite");
			const { deciding, root, key, create, point, run, input } = await reviewedWithTasks(path);
			const first = (await create(0)) as TaskId;
			await point(first);
			expect((await run(first)).status).toBe("terminal");
			const other = (await create(0)) as TaskId;
			expect(await run(other)).toMatchObject({ outcome: { result: "superseded" } });
			await root.commit(async (tx) => {
				const index = await tx.doc(ReviewIndex, root.id);
				index.reviews = {
					...index.reviews,
					[key]: { adjudication: { task: other, input: JSON.stringify(input(0)) } },
				} as typeof index.reviews;
				delete (await tx.doc(VerdictDocument, root.id)).decisions![key];
			}, context);
			await deciding.close(context);
			const harness = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review);
			open.push(harness);

			expect(await harness.reviewed(revision)).toBe(false);
			await expect(harness.importFindings(revision, [], "t")).rejects.toMatchObject({ code: "notReviewed" });
		});

		it("refuses a recorded decision made by a task the review index no longer names", async () => {
			const path = join(directory, "changeset.sqlite");
			const { deciding, root, key, create, point, run } = await reviewedWithTasks(path);
			const first = (await create(0)) as TaskId;
			await point(first);
			await run(first);
			const second = (await create(0)) as TaskId;
			await point(second);
			expect(await run(second)).toMatchObject({ outcome: { result: "recorded" } });
			await deciding.close(context);
			const control = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review);
			open.push(control);
			expect(await control.reviewed(revision)).toBe(true);
			await control.close(context);
			const stale = await DismissHarness.open(await openSqliteStorage(path), createFakeModels().review);
			const staleRoot = await stale.harness.root(context);
			await staleRoot.commit(async (tx) => {
				(await tx.doc(VerdictDocument, staleRoot.id)).decisions = { [key]: { task: first, findingsVersion: 0 } };
			}, context);
			await stale.close(context);
			expect(root.id).toBe(staleRoot.id);
			const harness = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review);
			open.push(harness);

			expect(await harness.reviewed(revision)).toBe(false);
		});

		describe("a verdict stored before decision records existed", () => {
			it.each([
				["accepts one whose indexed input names the current findings version", 0, true],
				["refuses one whose indexed input names an older findings version", 1, false],
			])("%s", async (_name, indexedVersion, accepted) => {
				const path = join(directory, "changeset.sqlite");
				const { deciding, root, key, create, point, run, input } = await reviewedWithTasks(path);
				const task = (await create(0)) as TaskId;
				await point(task);
				expect(await run(task)).toMatchObject({ outcome: { result: "recorded" } });
				await root.commit(async (tx) => {
					const index = await tx.doc(ReviewIndex, root.id);
					index.reviews = {
						...index.reviews,
						[key]: { adjudication: { task, input: JSON.stringify(input(indexedVersion)) } },
					} as typeof index.reviews;
					delete (await tx.doc(VerdictDocument, root.id)).decisions![key];
				}, context);
				await deciding.close(context);
				const harness = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review);
				open.push(harness);

				expect(await harness.reviewed(revision)).toBe(accepted);
			});
		});
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
			"file:codex.json": {
				at: "t",
				ids: [external[0]!.id],
				skippedBodies: 0,
				reviewers: [{ name: "codex" }],
			},
			"file:claude.json": {
				at: "t",
				ids: [external[1]!.id],
				skippedBodies: 0,
				reviewers: [{ name: "claude-code" }],
			},
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
			(await tx.doc(FindingsDocument, root.id)).versions[key] = 2;
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

	it("uses the supplied repository root when its real path cannot be read", async () => {
		const root = repo();
		const path = join(root, "reviews/claude.json");
		writeFileSync(path, JSON.stringify({ reviewer: { name: "claude-code" }, findings: [] }));
		const realpath = vi
			.spyOn(fs, "realpath")
			.mockResolvedValueOnce(path)
			.mockRejectedValueOnce(new Error("root unavailable"));
		try {
			const importer = await FileImporter.open("reviews/claude.json", { cwd: root, repoRoot: root });

			expect(importer.source).toBe("file:reviews/claude.json");
			expect(await importer.import()).toEqual({
				findings: [],
				skippedBodies: 0,
				reviewers: [{ name: "claude-code" }],
			});
			expect(realpath.mock.calls).toEqual([[path], [root]]);
		} finally {
			realpath.mockRestore();
		}
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

	it("keeps a read failure's cause and names the repository-relative file", async () => {
		const root = repo();
		writeFileSync(join(root, "reviews/claude.json"), "{}");
		const failure = Object.assign(new Error("read denied"), { code: "EACCES" });
		const read = vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);
		try {
			await expect(FileImporter.open("reviews/claude.json", { cwd: root, repoRoot: root })).rejects.toMatchObject({
				name: "CompareError",
				code: "unreadable",
				message: "Melian cannot read reviews/claude.json: read denied",
				cause: failure,
			});
			expect(read).toHaveBeenCalledExactlyOnceWith(join(root, "reviews/claude.json"), "utf8");
		} finally {
			read.mockRestore();
		}
	});

	it("imports valid JSON at exactly maxReviewerFileBytes", async () => {
		const root = repo();
		const json = JSON.stringify({ reviewer: { name: "human" }, findings: [] });
		const text = json + " ".repeat(maxReviewerFileBytes - Buffer.byteLength(json));
		expect(Buffer.byteLength(text)).toBe(4_194_304);
		writeFileSync(join(root, "limit.json"), text);

		const importer = await FileImporter.open("limit.json", { cwd: root, repoRoot: root });

		expect(importer.source).toBe("file:limit.json");
		expect(await importer.import()).toEqual({ findings: [], skippedBodies: 0, reviewers: [{ name: "human" }] });
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

	it.each(["correctness", "none"])("carries the newest judgement's %s debt across rounds", async (golden) => {
		const harness = await memoryHarness();
		await storeReview(harness);
		const id = findings[0]!.id;
		const verdict = new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate();
		const rounds = [revision, { ...revision, head: "c".repeat(40) }, { ...revision, head: "d".repeat(40) }].map(
			(revision, index) => {
				const comparison = Comparison.of(revision);
				comparison.compare(verdict);
				comparison.record(`2026-10-0${index + 1}T00:00:00Z`);
				comparison.adjudicate(id, {
					verdict: "noise",
					by: "M",
					at: `2026-10-0${6 - index}T00:00:00Z`,
					golden: index === 0 ? golden : index === 1 ? "tests" : "removed-behaviour",
				});
				return comparison;
			},
		);
		const root = await harness.harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).verdicts = Object.fromEntries(
				rounds.map((round) => [revisionKey(round), verdict.toJSON()]),
			);
			(await tx.doc(ComparisonDocument, root.id)).comparisons = Object.fromEntries(
				rounds.map((round) => [revisionKey(round), round.toJSON()]),
			);
		}, context);
		const judgement = { verdict: "valid", by: "N", at: "2026-10-07T00:00:00Z" } as const;
		const updated = await harness.adjudicate(revision, id, judgement);
		expect(updated.head).toBe(rounds[2]!.head);
		expect(updated.adjudication(id)).toEqual({
			current: { ...judgement, golden },
			history: [rounds[2]!.adjudication(id)!.current],
		});
		expect((await harness.read({ base: updated.base, head: updated.head }))?.adjudication(id)?.current.golden).toBe(
			golden,
		);
		for (const round of rounds.slice(0, 2))
			expect((await harness.read({ base: round.base, head: round.head }))?.toJSON()).toEqual(round.toJSON());
		expect(new ComparisonSet(await harness.all("change")).backlog()).toEqual(
			golden === "none"
				? []
				: [
						{
							changeset: "change",
							target: updated.label(),
							id,
							title: findings[0]!.properties.explanation.what,
							lens: golden,
							verdict: "valid",
							at: judgement.at,
						},
					],
		);
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
		const entries = await ComparisonReader.open(storage).read("change");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.verdict?.all()).toHaveLength(2);
		expect(commit).not.toHaveBeenCalled();
		expect(await storage.task(pending, context)).toEqual(before);
		commit.mockRestore();
	});

	it("refreshes detached comparisons and drops stale matches and debt after a clean review", async () => {
		const storage = createMemoryStorage();
		const harness = await CompareHarness.open(storage, createFakeModels().review);
		open.push(harness);
		await storeReview(harness);
		const external = codex(13, 0);
		const comparison = await harness.importFindings(
			revision,
			[{ source: "file:codex.json", imported: imported(external) }],
			"2026-10-05T00:00:00Z",
		);
		expect(comparison.effectiveMatches()).toEqual([{ external: external.id, melian: findings[0]!.id, kind: "site" }]);
		const adjudicated = await harness.adjudicate(revision, findings[0]!.id, {
			verdict: "valid",
			golden: "correctness",
			by: "Ada",
			at: "2026-10-05T01:00:00Z",
		});
		expect(adjudicated.backlog()).toMatchObject([{ id: findings[0]!.id, lens: "correctness" }]);
		const root = await harness.harness.root(context);
		const clean = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate();
		await root.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).verdicts[revisionKey(revision)] = clean.toJSON();
		}, context);

		const entries = await ComparisonReader.open(storage).read("change");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.verdict?.all()).toEqual([]);
		expect(entries[0]!.comparison.externalFindings().map((each) => each.id)).toEqual([external.id]);
		expect.soft(entries[0]!.comparison.effectiveMatches()).toEqual([]);
		expect.soft(entries[0]!.comparison.melianFindings()).toEqual([]);
		expect.soft(new ComparisonSet(entries).backlog()).toEqual([]);
		expect((await harness.read(revision))?.toJSON()).toEqual(adjudicated.toJSON());
	});

	describe("documents of other versions", () => {
		type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
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

		async function openRoot() {
			const storage = createMemoryStorage();
			const harness = await CompareHarness.open(storage, createFakeModels().review);
			open.push(harness);
			return { storage, root: await harness.harness.root(context) };
		}
		const comparisons = () => ({ [revisionKey(revision)]: Comparison.of(revision).toJSON() });

		it("migrates a version 2 verdict document through the reader", async () => {
			const verdict = new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate();
			const cause = {
				file: "src/run.ts",
				startLine: 12,
				role: "cause",
				revision: "head",
				snippet: "eval(input)",
			} as const;
			const json = verdict.toJSON();
			json.findings.block[0]!.properties.evidence = [cause];
			const { storage, root } = await openRoot();
			await root.commit(async (tx) => {
				(await tx.doc(ComparisonDocument, root.id)).comparisons = comparisons();
				const old = await tx.doc(legacy(VerdictDocument.definition.kind, 2), root.id);
				old.verdicts = JSON.parse(JSON.stringify(oldEvidence({ [revisionKey(revision)]: json })));
			}, context);
			const entries = await ComparisonReader.open(storage).read("change");
			expect(entries).toHaveLength(1);
			expect(entries[0]?.verdict?.all()).toHaveLength(2);
			expect(entries[0]?.verdict?.toJSON().findings.block[0]?.properties.evidence).toEqual([cause]);
		});

		it("refuses a comparison document newer than this Melian", async () => {
			const { storage, root } = await openRoot();
			await root.commit(async (tx) => {
				(await tx.doc(legacy(ComparisonDocument.definition.kind, 99), root.id)).comparisons = {};
			}, context);
			await expect(ComparisonReader.open(storage).read("change")).rejects.toMatchObject({
				message: "comparison document has newer version 99",
			});
		});

		it("refuses a verdict document newer than this Melian", async () => {
			const { storage, root } = await openRoot();
			await root.commit(async (tx) => {
				(await tx.doc(ComparisonDocument, root.id)).comparisons = comparisons();
				(await tx.doc(legacy(VerdictDocument.definition.kind, 99), root.id)).verdicts = {};
			}, context);
			await expect(ComparisonReader.open(storage).read("change")).rejects.toMatchObject({
				message: "verdict document has newer version 99",
			});
		});
	});

	it("reads an empty storage without creating a root or a comparison document", async () => {
		const storage = createMemoryStorage();
		try {
			const commit = vi.spyOn(storage, "commit");
			expect(await ComparisonReader.open(storage).read("change")).toEqual([]);
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

describe("stored comparison guards", () => {
	type Round = { revision: { base: string; head: string }; comparison: Comparison; verdict: boolean };
	const clean = new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate();
	const round = (head: string, options: { at?: string; verdict?: boolean } = {}): Round => {
		const revision = { base: "a".repeat(40), head: head.repeat(40) };
		const comparison = Comparison.of(revision);
		comparison.compare(clean);
		if (options.at !== undefined) comparison.record(options.at);
		return { revision, comparison, verdict: options.verdict ?? true };
	};
	async function stored(rounds: Round[], options: { verdicts?: boolean; verdict?: typeof clean } = {}) {
		const storage = createMemoryStorage();
		const harness = await CompareHarness.open(storage, createFakeModels().review);
		open.push(harness);
		const root = await harness.harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(ComparisonDocument, root.id)).comparisons = Object.fromEntries(
				rounds.map((each) => [revisionKey(each.revision), each.comparison.toJSON()]),
			);
			if (options.verdicts === false) return;
			(await tx.doc(VerdictDocument, root.id)).verdicts = Object.fromEntries(
				rounds
					.filter((each) => each.verdict)
					.map((each) => [revisionKey(each.revision), (options.verdict ?? clean).toJSON()]),
			);
		}, context);
		return { storage, harness };
	}
	const id = findings[0]!.id;
	const judgement = { verdict: "valid", by: "M", at: "2026-10-07T00:00:00Z" } as const;

	it("reads an absent comparison document, and a round without its verdict, as empty", async () => {
		const empty = await memoryHarness();
		expect(await empty.all("change")).toEqual([]);
		const { harness, storage } = await stored([
			round("b", { at: "2026-10-05T00:00:00Z" }),
			round("c", { verdict: false }),
		]);
		for (const entries of [await harness.all("change"), await ComparisonReader.open(storage).read("change")]) {
			expect(entries).toHaveLength(2);
			expect(entries[0]?.verdict?.all()).toHaveLength(2);
			expect(entries[1]).not.toHaveProperty("verdict");
		}
		const bare = await stored([round("b")], { verdicts: false });
		for (const entries of [
			await bare.harness.all("change"),
			await ComparisonReader.open(bare.storage).read("change"),
		]) {
			expect(entries).toHaveLength(1);
			expect(entries[0]).not.toHaveProperty("verdict");
		}
	});

	it("reads nothing when the stored document cannot be fetched", async () => {
		const { storage } = await stored([round("b")]);
		vi.spyOn(storage, "document").mockResolvedValueOnce(undefined);
		expect(await ComparisonReader.open(storage).read("change")).toEqual([]);
	});

	it("refreshes matches and debt against the stored verdict when it lists all rounds", async () => {
		const external = codex(13, 0);
		const comparison = Comparison.of(revision);
		comparison.import("file:codex.json", imported(external), "2026-10-05T00:00:00Z");
		comparison.compare(new Adjudication({ findings, manifest: [], checks: [], config: defaultConfig }).adjudicate());
		const none = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate();
		const { harness } = await stored([{ revision, comparison, verdict: true }], { verdict: none });
		const [entry] = await harness.all("change");
		expect(entry?.comparison.effectiveMatches()).toEqual([]);
		expect(entry?.comparison.melianFindings()).toEqual([]);
	});

	it("finds an external finding's round, and refuses an ID no round holds", async () => {
		const harness = await memoryHarness();
		await storeReview(harness);
		const external = codex(90, 0);
		await harness.importFindings(
			revision,
			[{ source: "file:codex.json", imported: imported(external) }],
			"2026-10-05T00:00:00Z",
		);
		const reason = { ...judgement, reason: "no-owner" } as const;
		expect((await harness.adjudicate(revision, external.id, reason)).adjudication(external.id)?.current).toEqual(
			reason,
		);
		await expect(harness.adjudicate(revision, "0123456789abcdef", judgement)).rejects.toMatchObject({
			code: "unknownFinding",
		});
	});

	it("prefers the later stored round when two rounds share a time", async () => {
		const { harness } = await stored([
			round("b", { at: "2026-10-05T00:00:00Z" }),
			round("c", { at: "2026-10-05T00:00:00Z" }),
		]);
		expect((await harness.adjudicate({ base: "a".repeat(40), head: "b".repeat(40) }, id, judgement)).head).toBe(
			"c".repeat(40),
		);
	});

	it("ranks an unrecorded round below a recorded one, and does not refresh a round without a verdict", async () => {
		const { harness } = await stored([round("b", { at: "2026-10-05T00:00:00Z" }), round("c", { verdict: false })]);
		const updated = await harness.adjudicate({ base: "a".repeat(40), head: "b".repeat(40) }, id, judgement);
		expect(updated.head).toBe("b".repeat(40));
	});

	it("records the first time and the target on an older document that lacks them", async () => {
		const { harness } = await stored([round("b")]);
		const target = { base: "a".repeat(40), head: "b".repeat(40), target: "main...feature" };
		await harness.adjudicate(target, id, judgement);
		const read = await harness.read(target);
		expect(read?.label()).toBe("main...feature");
		expect(read?.recordedAt()).toBe(judgement.at);
	});
});
