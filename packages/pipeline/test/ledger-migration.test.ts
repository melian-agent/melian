import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Adjudication,
	defaultConfig,
	Finding,
	type LedgerHistory,
	type LedgerRound,
	type PostedLedger,
	type PublicationDetails,
	type StoredVerdict,
	Verdict,
	type Walkthrough,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type Harness,
	openHarness,
	openSqliteStorage,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { LedgerDocument, PublishedDocument } from "../src/publish.ts";

type OldPublication = {
	order: string[];
	revisions: Record<
		string,
		{
			reviews: string[];
			verdict: string;
			verdictRevision: string;
			rounds: number;
			open: Record<string, { ruleId: string; path: string; line: number; revision: string; thread: string }>;
			resolved: Record<string, { ruleId: string; path: string; line: number; revision: string; thread: string }>;
			replies: Record<string, string | null>;
		}
	>;
};
const PreviousPublished = defineDoc<OldPublication>({
	kind: "melian.published",
	version: 3,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ order: [], revisions: {} }),
});
const PreviousVerdicts = defineDoc<{ verdicts: Record<string, StoredVerdict> }>({
	kind: "melian.verdicts",
	version: 3,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ verdicts: {} }),
});
let dir: string;
let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe("ledger document migration", () => {
	it("upgrades snapshots recorded by version-5 review and publication code after reopening", async () => {
		type Recorded = {
			recordedBy: string;
			verdictVersion: number;
			publishedVersion: number;
			verdicts: { verdicts: Record<string, StoredVerdict>; details: Record<string, PublicationDetails> };
			published: OldPublication & { ledgerRounds: LedgerRound[] };
		};
		const recorded = JSON.parse(
			readFileSync(new URL("./fixtures/stored-v5/review.json", import.meta.url), "utf8"),
		) as Recorded;
		expect([recorded.verdictVersion, recorded.publishedVersion]).toEqual([5, 5]);
		const oldVerdicts = defineDoc<Recorded["verdicts"]>({
			kind: "melian.verdicts",
			version: 5,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ verdicts: {}, details: {} }),
		});
		const oldPublished = defineDoc<Recorded["published"]>({
			kind: "melian.published",
			version: 5,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ order: [], revisions: {}, ledgerRounds: [] }),
		});
		dir = mkdtempSync(join(tmpdir(), "melian-recorded-v5-"));
		const database = join(dir, "state.sqlite");
		const fake = createFakeModels();
		const open = async () =>
			openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
		harness = await open();
		let root = await harness.root(context);
		await root.commit(async (tx) => {
			Object.assign(await tx.doc(oldVerdicts, root.id), recorded.verdicts);
			Object.assign(await tx.doc(oldPublished, root.id), recorded.published);
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect(await harness.snapshot(VerdictDocument, root.id, context)).toEqual(recorded.verdicts);
		expect(await harness.snapshot(PublishedDocument, root.id, context)).toEqual({
			...recorded.published,
			revisions: Object.fromEntries(
				Object.entries(recorded.published.revisions).map(([head, record]) => [
					head,
					{ ...record, publishedBy: { trustedWriters: true } },
				]),
			),
			ledgerRounds: recorded.published.ledgerRounds.map((round) => ({
				...round,
				publishedBy: { trustedWriters: true },
			})),
		});
		const revision = Object.keys(recorded.verdicts.verdicts)[0]!;
		expect(recorded.verdicts.details[revision]!.lenses[0]).not.toHaveProperty("standards");
		await root.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).details![revision]!.lenses[0]!.standards = ["AGENTS.md"];
			const round = (await tx.doc(PublishedDocument, root.id)).ledgerRounds!.at(-1)!;
			if ("verdict" in round) round.details!.lenses[0]!.standards = ["AGENTS.md"];
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect(
			(await harness.snapshot(VerdictDocument, root.id, context))!.details![revision]!.lenses[0]!.standards,
		).toEqual(["AGENTS.md"]);
		const round = (await harness.snapshot(PublishedDocument, root.id, context))!.ledgerRounds!.at(-1)!;
		expect(round).toHaveProperty("details.lenses.0.standards", ["AGENTS.md"]);
		await expect(harness.snapshot(oldVerdicts, root.id, context)).rejects.toThrow(/newer version 6 than 5/);
		await expect(harness.snapshot(oldPublished, root.id, context)).rejects.toThrow(/newer version 7 than 5/);
	});

	it.each([1, 2, 3, 4, 5])(
		"preserves a version %i verdict across a reopen and current-version write",
		async (version) => {
			dir = mkdtempSync(join(tmpdir(), "melian-verdict-migration-"));
			const database = join(dir, "state.sqlite");
			const fake = createFakeModels();
			const open = async () =>
				openHarness(
					await openSqliteStorage(database),
					{ models: fake.models, registry: createRegistry() },
					context,
				);
			const previous = defineDoc<{
				verdicts: Record<string, StoredVerdict>;
				provenance?: Record<
					string,
					{ kind: "range"; policy: string; manifest: string[]; lenses: string[]; verifierVersion: string }
				>;
				decisions?: Record<string, { task: number; findingsVersion: number }>;
			}>({
				kind: "melian.verdicts",
				version,
				scope: "conversation",
				history: "rewindable",
				fork: "asOf",
				initial: () => ({ verdicts: {} }),
			});
			const finding = Finding.create({
				rule: "unsafe",
				message: "Unsafe input",
				file: "src/run.ts",
				startLine: 1,
				snippet: "run(input)",
				occurrence: 0,
				severity: "P1",
				cause: "introduced",
				source: { check: "lens.security", version: "1@careful" },
				failureScenario: "Passing unchecked input runs it.",
				evidence: [{ file: "src/run.ts", startLine: 1, role: "context", revision: "head", snippet: "run(input)" }],
				explanation: { what: "Unsafe input", whyHere: "New input", whatToDo: "Validate it" },
			});
			const verified = Finding.from({
				...finding.toJSON(),
				properties: {
					...finding.properties,
					verification: {
						verdict: "refuted",
						reason: "A guard checks input.",
						executor: "llm",
						model: "fake/judge",
						version: "verifier-v1",
					},
				},
			});
			const verdict = new Adjudication({
				findings: [version < 3 ? finding : verified],
				manifest: [],
				checks: [],
				config: defaultConfig,
			})
				.adjudicate()
				.toJSON();
			const head = "b".repeat(40);
			const revision = version === 1 ? head : `${"a".repeat(40)}..${head}`;
			const stored = {
				verdicts: { [revision]: verdict },
				...(version < 3
					? {}
					: {
							provenance: {
								[revision]: {
									kind: "range" as const,
									policy: "config",
									manifest: [],
									lenses: [],
									verifierVersion: "verifier-v1",
								},
							},
							decisions: { [revision]: { task: 42, findingsVersion: 7 } },
						}),
			};
			harness = await open();
			let root = await harness.root(context);
			await root.commit(async (tx) => Object.assign(await tx.doc(previous, root.id), stored), context);
			await harness.close(context);
			harness = await open();
			root = await harness.root(context);
			expect(await harness.snapshot(VerdictDocument, root.id, context)).toEqual(stored);
			await root.commit(async (tx) => {
				(await tx.doc(VerdictDocument, root.id)).walkthroughNotes = { [revision]: "No walkthrough stored." };
			}, context);
			await harness.close(context);
			harness = await open();
			root = await harness.root(context);
			const migrated = await harness.snapshot(VerdictDocument, root.id, context);
			expect(migrated).toEqual({ ...stored, walkthroughNotes: { [revision]: "No walkthrough stored." } });
			expect(Verdict.from(migrated!.verdicts[revision]!).fingerprint()).toBe(Verdict.from(verdict).fingerprint());
		},
	);

	it("reads version 3 records without inventing history or changing replies, and writes the current versions", async () => {
		dir = mkdtempSync(join(tmpdir(), "melian-ledger-migration-"));
		const database = join(dir, "state.sqlite");
		const fake = createFakeModels();
		const open = async () =>
			openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
		harness = await open();
		let root = await harness.root(context);
		const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
			.adjudicate()
			.toJSON();
		const head = "b".repeat(40);
		const revision = `${"a".repeat(40)}..${head}`;
		const record = {
			reviews: ["201"],
			verdict: "0123456789abcdef",
			verdictRevision: revision,
			rounds: 1,
			open: {},
			resolved: {},
			replies: { "0123456789abcdef 202": "203" },
		};
		await root.commit(async (tx) => {
			const published = await tx.doc(PreviousPublished, root.id);
			published.order = [head];
			published.revisions = { [head]: record };
			(await tx.doc(PreviousVerdicts, root.id)).verdicts = { [revision]: verdict };
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect(await harness.snapshot(PublishedDocument, root.id, context)).toEqual({
			order: [head],
			revisions: { [head]: { ...record, publishedBy: { trustedWriters: true } } },
		});
		expect((await harness.snapshot(VerdictDocument, root.id, context))?.verdicts[revision]).toEqual(verdict);
		expect(await harness.snapshot(LedgerDocument, root.id, context)).toBeUndefined();
		await root.commit(async (tx) => {
			(await tx.doc(PublishedDocument, root.id)).ledgerRounds = [];
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect((await harness.snapshot(PublishedDocument, root.id, context))?.ledgerRounds).toEqual([]);
		expect((await harness.snapshot(PublishedDocument, root.id, context))?.revisions[head]?.replies).toEqual(
			record.replies,
		);
	});
	it.each([5, 6])(
		"upgrades version-%i publisher attribution without inventing identities after reopening",
		async (version) => {
			dir = mkdtempSync(join(tmpdir(), "melian-ledger-migration-"));
			const database = join(dir, "state.sqlite");
			const fake = createFakeModels();
			const open = async () =>
				openHarness(
					await openSqliteStorage(database),
					{ models: fake.models, registry: createRegistry() },
					context,
				);
			const previous = defineDoc<OldPublication & { ledgerRounds: (LedgerRound | LedgerHistory)[] }>({
				kind: "melian.published",
				version,
				scope: "conversation",
				history: "latest",
				fork: "current",
				initial: () => ({ order: [], revisions: {}, ledgerRounds: [] }),
			});
			const base = "a".repeat(40);
			const head = "b".repeat(40);
			const record = {
				reviews: ["201"],
				verdict: "0123456789abcdef",
				verdictRevision: `${base}..${head}`,
				rounds: 1,
				open: {},
				resolved: {},
				replies: { "finding thread": "203" },
				status: { state: "success" as const, description: "passed" },
			};
			const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
				.adjudicate()
				.toJSON();
			const history = { base, head: "c".repeat(40), round: 1, status: "passed" as const };
			const round = {
				base,
				head,
				round: 1,
				verdict,
				resolved: [],
				details: { policy: "config", manifest: [], lenses: [], standards: [] },
			};
			harness = await open();
			let root = await harness.root(context);
			await root.commit(async (tx) => {
				const doc = await tx.doc(previous, root.id);
				doc.order = [head];
				doc.revisions = { [head]: record };
				doc.ledgerRounds = [history, round];
			}, context);
			await harness.close(context);
			harness = await open();
			root = await harness.root(context);
			const upgraded = {
				order: [head],
				revisions: { [head]: { ...record, publishedBy: { trustedWriters: true } } },
				ledgerRounds: [history, { ...round, publishedBy: { trustedWriters: true } }],
			};
			expect(await harness.snapshot(PublishedDocument, root.id, context)).toEqual(upgraded);
			await root.commit(async (tx) => {
				await tx.doc(PublishedDocument, root.id);
			}, context);
			await harness.close(context);
			harness = await open();
			root = await harness.root(context);
			expect(await harness.snapshot(PublishedDocument, root.id, context)).toEqual(upgraded);
		},
	);

	it("migrates version 4 fallback notes and prunes old ledger detail after reopening", async () => {
		dir = mkdtempSync(join(tmpdir(), "melian-ledger-migration-"));
		const database = join(dir, "state.sqlite");
		const fake = createFakeModels();
		const open = async () =>
			openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
		const oldVerdicts = defineDoc<{
			verdicts: Record<string, StoredVerdict>;
			walkthroughs: Record<string, Walkthrough>;
		}>({
			kind: "melian.verdicts",
			version: 4,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ verdicts: {}, walkthroughs: {} }),
		});
		const oldPublished = defineDoc<OldPublication & { ledgerRounds: LedgerRound[] }>({
			kind: "melian.published",
			version: 4,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ order: [], revisions: {}, ledgerRounds: [] }),
		});
		const oldLedger = defineDoc<{ comment?: PostedLedger }>({
			kind: "melian.ledger",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({}),
		});
		const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
			.adjudicate()
			.toJSON();
		const base = "a".repeat(40);
		const head = "b".repeat(40);
		const revision = `${base}..${head}`;
		const round = {
			base,
			head,
			round: 1,
			verdict,
			resolved: [],
			walkthrough: { summary: "Stored summary.", files: [] },
			details: { policy: "config", manifest: [], lenses: [], standards: [] },
		};
		const comment = {
			id: "17",
			url: "https://example.test/17",
			stamp: {
				version: 1 as const,
				base,
				head,
				round: 1,
				verdict: "0123456789abcdef",
				counts: { open: 0, blocking: 0, dismissed: 0 },
				lenses: [],
				plan: null,
				projection: "0123456789abcdef",
			},
		};
		harness = await open();
		let root = await harness.root(context);
		await root.commit(async (tx) => {
			const doc = await tx.doc(oldVerdicts, root.id);
			doc.verdicts = { [revision]: verdict };
			doc.walkthroughs = {
				[revision]: {
					summary: "No walkthrough available.",
					files: [],
					note: "The summariser done: private provider detail.",
				},
				success: { summary: "Real summary.", files: [] },
			};
			(await tx.doc(oldPublished, root.id)).ledgerRounds = [round, { ...round, round: 2 }];
			(await tx.doc(oldLedger, root.id)).comment = comment;
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		const doc = await harness.snapshot(VerdictDocument, root.id, context);
		expect(doc?.walkthroughs?.[revision]).toBeUndefined();
		expect(doc?.walkthroughs?.success?.summary).toBe("Real summary.");
		expect(doc?.walkthroughNotes?.[revision]).toBe("No walkthrough available. The summariser returned no summary.");
		expect(JSON.stringify(doc)).not.toContain("private provider detail");
		const rounds = (await harness.snapshot(PublishedDocument, root.id, context))?.ledgerRounds;
		expect(rounds?.[0]).toEqual({ base, head, round: 1, status: "passed" });
		expect(rounds?.[1]).toEqual({ ...round, round: 2, publishedBy: { trustedWriters: true } });
		expect((await harness.snapshot(LedgerDocument, root.id, context))?.comment).toEqual(comment);
	});
	it("reads version 5 lens details with standards absent and preserves them on upgrade", async () => {
		dir = mkdtempSync(join(tmpdir(), "melian-standards-migration-"));
		const database = join(dir, "state.sqlite");
		const fake = createFakeModels();
		const open = async () =>
			openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
		const old = defineDoc<{ verdicts: Record<string, StoredVerdict>; details: Record<string, PublicationDetails> }>({
			kind: "melian.verdicts",
			version: 5,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ verdicts: {}, details: {} }),
		});
		const oldPublished = defineDoc<OldPublication & { ledgerRounds: LedgerRound[] }>({
			kind: "melian.published",
			version: 5,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ order: [], revisions: {}, ledgerRounds: [] }),
		});
		const details = {
			policy: "config",
			manifest: ["lens.correctness"],
			standards: ["AGENTS.md"],
			lenses: [
				{ name: "correctness", version: "1", level: "careful", models: ["fake/model"], budget: { findings: 8 } },
			],
		};
		harness = await open();
		let root = await harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(old, root.id)).details.head = details;
			(await tx.doc(oldPublished, root.id)).ledgerRounds = [
				{
					base: "a".repeat(40),
					head: "b".repeat(40),
					round: 1,
					verdict: new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
						.adjudicate()
						.toJSON(),
					resolved: [],
					details,
				},
			];
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect((await harness.snapshot(VerdictDocument, root.id, context))?.details?.head).toEqual(details);
		expect((await harness.snapshot(PublishedDocument, root.id, context))?.ledgerRounds?.at(-1)).toMatchObject({
			details,
		});
		expect(
			(await harness.snapshot(VerdictDocument, root.id, context))?.details?.head?.lenses[0]?.standards,
		).toBeUndefined();
		await root.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).details!.head!.lenses[0]!.standards = ["AGENTS.md"];
		}, context);
		await harness.close(context);
		harness = await open();
		root = await harness.root(context);
		expect((await harness.snapshot(VerdictDocument, root.id, context))?.details?.head?.lenses[0]?.standards).toEqual([
			"AGENTS.md",
		]);
	});
});
