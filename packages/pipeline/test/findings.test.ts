import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFinding,
	defaultConfig,
	type Finding,
	FindingError,
	type FindingInput,
	type FindingSource,
	resolveFinding,
	type Verdict,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineDoc,
	dismissFinding,
	type Harness,
	openHarness,
	openSqliteStorage,
	readFindings,
	readVerdict,
	recordRevision,
	type Storage,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StoredVerdict, upgradeStoredVerdict } from "../src/adjudication.ts";
import { FindingsDocument } from "../src/findings.ts";
import { fingerprint, legacyFingerprint, PublishedDocument } from "../src/publish.ts";

const input: FindingInput = {
	rule: "no-eval",
	message: "eval runs request input",
	file: "src/run.ts",
	startLine: 12,
	snippet: "eval(input)",
	occurrence: 0,
	cause: "introduced",
	severity: "P1",
	resolution: "block",
	explanation: {
		what: "The handler passes the request body to eval.",
		whyHere: "This change routes the body into run().",
		whatToDo: "Parse the body with JSON.parse.",
	},
	source: { check: "lens.security", version: "1" },
};

const evalFinding = createFinding(input);

// A finding as readFindings returns it: merged from its sightings, naming every producer.
function seen(finding: Finding, ...also: FindingSource[]): Finding {
	const reportedBy = [finding.properties.source, ...also];
	return { ...finding, properties: { ...finding.properties, reportedBy } };
}

let dir: string;
let opened: Harness[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-findings-"));
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((harness) => harness.close(context)));
	rmSync(dir, { recursive: true, force: true });
});

async function open(storage: Storage) {
	const fake = createFakeModels();
	const harness = await openHarness(storage, { models: fake.models, registry: createRegistry() });
	opened.push(harness);
	return { harness, root: await harness.root(context, { agent: { model: fake.ref() } }) };
}

describe("the findings document", () => {
	it("reads as empty before anything is reported", async () => {
		const { harness, root } = await open(createMemoryStorage());
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([]);
	});

	it("stores a finding upserted twice under one ID once", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const reworded = createFinding({ ...input, message: "eval runs the request body" });
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([seen(evalFinding)]);

		await root.commit((tx) => upsertFinding(tx, root.id, reworded, "rev1"), context);
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([seen(reworded)]);
	});

	it("keeps findings with different IDs apart, in ID order", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const other = createFinding({ ...input, snippet: "eval(body)" });
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, evalFinding, "rev1");
			await upsertFinding(tx, root.id, other, "rev1");
		}, context);
		const ids = [evalFinding, other].map((finding) => finding.properties.id).sort();
		expect((await readFindings(harness, root.id, "rev1", context)).map((finding) => finding.properties.id)).toEqual(
			ids,
		);
	});

	it("stores a finding with nested undefined values as its JSON form", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const loose = { ...evalFinding, message: { text: evalFinding.message.text, markdown: undefined } } as Finding;
		await root.commit((tx) => upsertFinding(tx, root.id, loose, "rev1"), context);
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([seen(evalFinding)]);
	});

	it("returns copies, so changing one does not change the committed document", async () => {
		const { harness, root } = await open(createMemoryStorage());
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		const [read] = (await readFindings(harness, root.id, "rev1", context)) as Finding[];
		(read!.properties.explanation as { what: string }).what = "changed by a reader";
		read!.locations.pop();
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([seen(evalFinding)]);
	});

	it("refuses an invalid finding and commits nothing", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const invalid: Finding = { ...evalFinding, level: "note" };
		const committed = root.commit(async (tx) => {
			await upsertFinding(tx, root.id, evalFinding, "rev1");
			await upsertFinding(tx, root.id, invalid, "rev1");
		}, context);
		await expect(committed).rejects.toBeInstanceOf(FindingError);
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([]);
	});

	describe("lifecycle", () => {
		const dismissal = { by: "tal", reason: "eval input is a constant here", at: "2026-10-03T00:00:00.000Z" };
		const triggered = (snippet: string) =>
			createFinding({
				...input,
				trigger: { file: "src/run.ts", index: 0, snippet },
			});

		async function lifecycle(harness: Harness, id: string) {
			return (await harness.snapshot(FindingsDocument, root.id, context))?.items[id]?.lifecycle;
		}

		let harness: Harness;
		let root: Awaited<ReturnType<typeof open>>["root"];

		beforeEach(async () => {
			({ harness, root } = await open(createMemoryStorage()));
		});

		it("is new when an ID is first seen, and tracks the revisions that report it", async () => {
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev2"), context);
			expect(await lifecycle(harness, evalFinding.properties.id)).toEqual({
				status: "new",
				firstSeenRevision: "rev1",
				lastSeenRevision: "rev2",
				history: [],
			});
		});

		it("keeps a dismissal when the same report is replayed", async () => {
			const finding = triggered("eval(input)");
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev1"), context);
			await root.commit((tx) => dismissFinding(tx, root.id, finding.properties.id, dismissal), context);
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev1"), context);
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev2"), context);
			expect((await readFindings(harness, root.id, "rev2", context)).map((each) => each.properties.status)).toEqual([
				"dismissed",
			]);
			expect(await lifecycle(harness, finding.properties.id)).toEqual({
				status: "dismissed",
				dismissedBy: "tal",
				dismissedReason: "eval input is a constant here",
				dismissedAt: "2026-10-03T00:00:00.000Z",
				firstSeenRevision: "rev1",
				lastSeenRevision: "rev2",
				history: [],
			});
		});

		it("keeps a dismissal when the trigger only moves or is rewrapped", async () => {
			const finding = triggered("eval(input)");
			const moved = createFinding({
				...input,
				trigger: { file: "src/run.ts", index: 2, snippet: "  eval(\n    input\n  )\n" },
			});
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev1"), context);
			await root.commit((tx) => dismissFinding(tx, root.id, finding.properties.id, dismissal), context);
			await root.commit((tx) => upsertFinding(tx, root.id, moved, "rev2"), context);
			expect((await lifecycle(harness, finding.properties.id))?.status).toBe("dismissed");
		});

		it("reopens a dismissed finding whose trigger's code changed, keeping the dismissal in its history", async () => {
			const finding = triggered("run(eval(input))");
			const changed = triggered("run(eval(input), { strict: true })");
			await root.commit((tx) => upsertFinding(tx, root.id, finding, "rev1"), context);
			await root.commit((tx) => dismissFinding(tx, root.id, finding.properties.id, dismissal), context);
			await root.commit((tx) => upsertFinding(tx, root.id, changed, "rev2"), context);
			await root.commit((tx) => upsertFinding(tx, root.id, changed, "rev2"), context);
			expect(await readFindings(harness, root.id, "rev2", context)).toEqual([seen(changed)]);
			expect(await lifecycle(harness, finding.properties.id)).toEqual({
				status: "new",
				firstSeenRevision: "rev1",
				lastSeenRevision: "rev2",
				history: [
					{
						dismissedBy: "tal",
						dismissedReason: "eval input is a constant here",
						dismissedAt: "2026-10-03T00:00:00.000Z",
						reopenedRevision: "rev2",
					},
				],
			});
		});

		it("refuses to dismiss a finding nobody reported", async () => {
			const dismissed = root.commit((tx) => dismissFinding(tx, root.id, "0123456789abcdef", dismissal), context);
			await expect(dismissed).rejects.toMatchObject({ code: "unknownFinding" });
		});
	});

	describe("sightings", () => {
		const security = input.source;
		const style = { check: "lens.style", version: "7" };
		const fromStyle = (severity: FindingInput["severity"]) =>
			createFinding({ ...input, severity, resolution: "advisory", source: style });

		it("merges two lenses' sightings of one ID at one head, the higher severity winning", async () => {
			const { harness, root } = await open(createMemoryStorage());
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, fromStyle("P2"), "rev1");
				await upsertFinding(tx, root.id, evalFinding, "rev1");
			}, context);
			const [merged] = await readFindings(harness, root.id, "rev1", context);
			expect(merged).toEqual(seen(evalFinding, style));

			await root.commit((tx) => upsertFinding(tx, root.id, fromStyle("P0"), "rev1"), context);
			const [promoted] = await readFindings(harness, root.id, "rev1", context);
			expect(promoted!.properties).toMatchObject({ severity: "P0", source: style, reportedBy: [security, style] });
		});

		it("keeps the evidenced cause of a less severe sighting, and its whole claim, so the merge still blocks", async () => {
			const { harness, root } = await open(createMemoryStorage());
			const evidence = [
				{
					file: "src/api.ts",
					startLine: 3,
					role: "cause" as const,
					revision: "head" as const,
					snippet: "export function run(body) {",
				},
			];
			const failureScenario = "run('process.exit()') stops the server.";
			const evidenced = createFinding({ ...input, cause: "affected", evidence, failureScenario });
			const contextOnly = [{ ...evidence[0]!, role: "context" as const }];
			const unproven = createFinding({
				...input,
				severity: "P0",
				cause: "pre-existing",
				evidence: contextOnly,
				failureScenario: "A guess.",
				source: style,
			});
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, evidenced, "rev1");
				await upsertFinding(tx, root.id, unproven, "rev1");
			}, context);
			const [merged] = await readFindings(harness, root.id, "rev1", context);
			expect(merged!.properties).toMatchObject({
				severity: "P0",
				source: style,
				cause: "affected",
				evidence: [...contextOnly, ...evidence],
				failureScenario: "A guess.",
				otherClaims: [
					{ id: evidenced.properties.id, ruleId: "no-eval", source: security, failureScenario, evidence },
				],
			});
			expect(resolveFinding(merged!, defaultConfig)).toBe("block");
		});

		it("breaks a severity tie by lens name", async () => {
			const { harness, root } = await open(createMemoryStorage());
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, fromStyle("P1"), "rev1");
				await upsertFinding(tx, root.id, evalFinding, "rev1");
			}, context);
			const [merged] = await readFindings(harness, root.id, "rev1", context);
			expect(merged!.properties.source).toEqual(security);
		});

		it("lets a replay or correction replace only the same lens's sighting at that head", async () => {
			const { harness, root } = await open(createMemoryStorage());
			const corrected = createFinding({ ...input, message: "corrected" });
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, evalFinding, "rev1");
				await upsertFinding(tx, root.id, fromStyle("P3"), "rev1");
				await upsertFinding(tx, root.id, evalFinding, "rev2");
				await upsertFinding(tx, root.id, corrected, "rev1");
			}, context);
			const [atRev1] = await readFindings(harness, root.id, "rev1", context);
			expect(atRev1).toEqual(seen(corrected, style));
			expect(await readFindings(harness, root.id, "rev2", context)).toEqual([seen(evalFinding)]);
		});

		it("never lets a resumed review of an old head change what the newer head reads", async () => {
			const { harness, root } = await open(createMemoryStorage());
			const dismissal = { by: "tal", reason: "constant input", at: "2026-10-03T00:00:00.000Z" };
			const old = createFinding({
				...input,
				message: "old head",
				trigger: { file: "src/run.ts", index: 0, snippet: "a()" },
			});
			const current = createFinding({ ...input, trigger: { file: "src/run.ts", index: 0, snippet: "b()" } });
			await root.commit((tx) => recordRevision(tx, root.id, "old"), context);
			await root.commit(async (tx) => {
				await recordRevision(tx, root.id, "new");
				await upsertFinding(tx, root.id, current, "new");
				await dismissFinding(tx, root.id, current.properties.id, dismissal);
			}, context);
			await root.commit((tx) => upsertFinding(tx, root.id, old, "old"), context);

			const [atNew] = await readFindings(harness, root.id, "new", context);
			expect(atNew!.message.text).toBe(input.message);
			expect(atNew!.properties.status).toBe("dismissed");
			const record = (await harness.snapshot(FindingsDocument, root.id, context))?.items[current.properties.id];
			expect(record?.lifecycle.lastSeenRevision).toBe("new");
			expect((await readFindings(harness, root.id, "old", context))[0]!.message.text).toBe("old head");
		});
	});

	it("survives a reopen", async () => {
		const path = join(dir, "findings.sqlite");
		const first = await open(await openSqliteStorage(path));
		await first.root.commit((tx) => upsertFinding(tx, first.root.id, evalFinding, "rev1"), context);
		await first.harness.close(context);

		const { harness, root } = await open(await openSqliteStorage(path));
		expect(root.id).toBe(first.root.id);
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([seen(evalFinding)]);
	});
});

// Documents of earlier versions, written raw, so a test can store the shape a released Melian left behind.
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Legacy = { [key: string]: Json };
const json = (value: unknown) => value as Json;

describe("documents stored before evidence became a list", () => {
	// The document as version 4 stored it: an affected sighting carried one evidence location, and none a scenario.
	const LegacyFindings = defineDoc<Legacy>({
		kind: "melian.findings",
		version: 4,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({ revisions: [], items: {}, versions: {} }),
	});

	it("reads a single evidence location as one cause at head, and a missing failure scenario as none", async () => {
		const evidence = [
			{ file: "src/api.ts", startLine: 3, role: "cause" as const, revision: "head" as const, snippet: "run(body)" },
		];
		const current = createFinding({ ...input, cause: "affected", evidence });
		const { status: _, ...properties } = current.properties;
		const { role: __, revision: ___, ...old } = evidence[0]!;
		const sighting = { ...current, properties: { ...properties, evidence: old } };
		const path = join(dir, "legacy.sqlite");
		const first = await open(await openSqliteStorage(path));
		await first.root.commit(async (tx) => {
			const state = await tx.doc(LegacyFindings, first.root.id);
			state.revisions = ["rev1"];
			state.items = json({
				[current.properties.id]: {
					lifecycle: { status: "new", firstSeenRevision: "rev1", lastSeenRevision: "rev1", history: [] },
					sightings: { rev1: { "lens.security@1": sighting } },
				},
			});
			state.versions = { rev1: 1 };
		}, context);
		await first.harness.close(context);

		const { harness, root } = await open(await openSqliteStorage(path));
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([seen(current)]);
		const later = createFinding({
			...input,
			snippet: "eval(body)",
			evidence,
			failureScenario: "eval('1') returns 1.",
		});
		await root.commit((tx) => upsertFinding(tx, root.id, later, "rev1"), context);
		expect(await readFindings(harness, root.id, "rev1", context)).toHaveLength(2);
	});

	const LegacyVerdicts = defineDoc<Legacy>({
		kind: "melian.verdicts",
		version: 2,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({ verdicts: {} }),
	});

	const LegacyPublished = defineDoc<Legacy>({
		kind: "melian.published",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({ order: [], revisions: {} }),
	});

	it("reads a recorded verdict, and a round left pending, with each finding in the current shape", async () => {
		const evidence = [
			{ file: "src/api.ts", startLine: 3, role: "cause" as const, revision: "head" as const, snippet: "run(body)" },
		];
		const current = createFinding({ ...input, cause: "affected", evidence });
		const { role: _, revision: __, ...old } = evidence[0]!;
		const stored = { ...current, properties: { ...current.properties, evidence: old } };
		const verdict = (finding: unknown) => ({
			status: "findings",
			blocking: true,
			findings: { block: [finding], acknowledge: [], advisory: [], silent: [] },
			dismissed: [finding],
			notRun: [],
		});
		const pending = (finding: unknown) => ({
			revision: "base..head",
			round: 1,
			fingerprint: "0123456789abcdef",
			verdict: verdict(finding),
			post: [{ finding, placement: { kind: "body" } }],
			stillOpen: 0,
			open: {},
			resolved: {},
			refusals: 0,
		});
		const path = join(dir, "legacy-verdicts.sqlite");
		const first = await open(await openSqliteStorage(path));
		await first.root.commit(async (tx) => {
			(await tx.doc(LegacyVerdicts, first.root.id)).verdicts = json({ "base..head": verdict(stored) });
			const published = await tx.doc(LegacyPublished, first.root.id);
			published.order = ["head"];
			published.revisions = json({
				head: { reviews: [], open: {}, resolved: {}, replies: {}, pending: pending(stored) },
			});
		}, context);
		await first.harness.close(context);

		const { harness, root } = await open(await openSqliteStorage(path));
		expect(await readVerdict(harness, root.id, "base..head", context)).toEqual(verdict(current));
		const published = await harness.snapshot(PublishedDocument, root.id, context);
		expect(published?.revisions.head?.pending).toEqual(pending(current));
	});

	it("knows a migrated verdict by the fingerprint it was published under, so its head takes no second review", async () => {
		const evidence = [
			{ file: "src/api.ts", startLine: 3, role: "cause" as const, revision: "head" as const, snippet: "run(body)" },
		];
		const current = createFinding({ ...input, cause: "affected", evidence });
		const { role: _, revision: __, ...old } = evidence[0]!;
		const stored = { ...current, properties: { ...current.properties, evidence: old } };
		const plain = createFinding({ ...input, snippet: "eval(body)" });
		const verdict = (finding: unknown) =>
			({
				status: "findings",
				blocking: true,
				findings: { block: [finding, plain], acknowledge: [], advisory: [], silent: [] },
				dismissed: [],
				notRun: [],
			}) as unknown as Verdict;
		const published = fingerprint(verdict(stored));
		const migrated = upgradeStoredVerdict(verdict(stored) as StoredVerdict) as Verdict;

		expect(fingerprint(migrated)).not.toBe(published);
		expect(legacyFingerprint(migrated)).toBe(published);
		const scenario = createFinding({ ...input, cause: "affected", evidence, failureScenario: "run(1) throws." });
		expect(legacyFingerprint(verdict(scenario))).toBeUndefined();
		const contextOnly = [{ ...evidence[0]!, role: "context" as const }];
		expect(legacyFingerprint(verdict(createFinding({ ...input, evidence: contextOnly })))).toBeUndefined();
	});
});
