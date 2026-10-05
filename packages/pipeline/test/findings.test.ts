import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Changeset,
	defaultConfig,
	dismissalVersion,
	Finding,
	FindingError,
	type FindingInput,
	type FindingSource,
	maxDismissalReasonLength,
	type PullRequest,
	type ReviewDraft,
	type ReviewProvider,
	Revision,
	replyKey,
	type StoredFinding,
	type StoredVerdict,
	snippetHash,
	Verdict,
	type Verification,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineDoc,
	dismissFinding,
	type Harness,
	openHarness,
	openPublishHarness,
	openSqliteStorage,
	publishReview,
	readFindings,
	readVerdict,
	recordRevision,
	type Storage,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { FindingsDocument, findingsVersion, upsertVerification } from "../src/findings.ts";
import { PublishedDocument, PublisherDocument } from "../src/publish.ts";

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

const evalFinding = Finding.create(input);

// A finding as readFindings returns it: merged from its sightings, naming every producer.
function seen(finding: Finding, ...also: FindingSource[]): Finding {
	const reportedBy = [finding.properties.source, ...also];
	return Finding.from({ ...finding.toJSON(), properties: { ...finding.properties, reportedBy } });
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
		const reworded = Finding.create({ ...input, message: "eval runs the request body" });
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([seen(evalFinding)]);

		await root.commit((tx) => upsertFinding(tx, root.id, reworded, "rev1"), context);
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([seen(reworded)]);
	});

	it.each([
		["confirmed", "plausible"],
		["confirmed", "refuted"],
		["plausible", "refuted"],
	] as const)("keeps %s over %s under parallel commits and retries", async (stronger, weaker) => {
		const { harness, root } = await open(createMemoryStorage());
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		const verdict = (value: Verification["verdict"]): Verification => ({
			verdict: value,
			reason: `Reported ${value}.`,
			executor: "llm",
			model: "fake/judge",
			version: "1",
		});
		await Promise.all(
			[stronger, weaker].map((value) =>
				root.commit(
					(tx) => upsertVerification(tx, root.id, "rev1", evalFinding.id, input.source, verdict(value)),
					context,
				),
			),
		);
		expect((await readFindings(harness, root.id, "rev1", context))[0]!.properties.verification?.verdict).toBe(
			stronger,
		);
		const version = await findingsVersion(harness, root.id, "rev1", context);
		await root.commit(
			(tx) => upsertVerification(tx, root.id, "rev1", evalFinding.id, input.source, verdict(weaker)),
			context,
		);
		expect(await findingsVersion(harness, root.id, "rev1", context)).toBe(version);
		expect((await readFindings(harness, root.id, "rev1", context))[0]!.properties.verification?.verdict).toBe(
			stronger,
		);
	});
	it("keeps findings with different IDs apart, in ID order", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const other = Finding.create({ ...input, snippet: "eval(body)" });
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
		const message = { text: evalFinding.message.text, markdown: undefined };
		const loose = Finding.from({ ...evalFinding.toJSON(), message } as StoredFinding);
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
		const invalid = Finding.from({ ...evalFinding.toJSON(), level: "note" });
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
			Finding.create({
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
			const moved = Finding.create({
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
			const [reopened] = await readFindings(harness, root.id, "rev2", context);
			expect(reopened).toEqual({
				...seen(changed),
				properties: {
					...seen(changed).properties,
					pastDismissals: [{ ...dismissal, reopenedRevision: "rev2" }],
				},
			});
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

		it("reads an affected trigger stored with one hash as a proof of that hunk, and reopens when it changes", async () => {
			const lib = snippetHash("+export const run = eval;");
			const util = snippetHash("+export const parse = JSON.parse;");
			const affected = (trigger: FindingInput["trigger"]) =>
				Finding.create({
					...input,
					cause: "affected",
					evidence: [
						{
							file: "src/lib.ts",
							startLine: 1,
							role: "cause",
							revision: "head",
							proves: true,
							snippet: "export const run = eval;",
						},
					],
					trigger,
				});
			const old = affected({ file: "src/lib.ts", index: 0, snippet: "export const run = eval;", hash: lib });
			const { status: _, ...sighting } = old.properties;
			await root.commit(async (tx) => {
				const state = await tx.doc(FindingsDocument, root.id);
				state.revisions.push("rev1");
				state.items[old.properties.id] = {
					lifecycle: {
						status: "dismissed",
						dismissedBy: dismissal.by,
						dismissedReason: dismissal.reason,
						dismissedAt: dismissal.at,
						firstSeenRevision: "rev1",
						lastSeenRevision: "rev1",
						history: [],
					},
					sightings: { rev1: { "lens.security@1": { ...old, properties: sighting } } },
				};
			}, context);
			const proof = [
				{ file: "src/lib.ts", hash: lib },
				{ file: "src/util.ts", hash: util },
			];
			const cited = affected({ file: "src/lib.ts", index: 0, snippet: "export const run = eval;", proof });

			await expect(root.commit((tx) => upsertFinding(tx, root.id, cited, "rev2"), context)).rejects.toThrow(
				/needs the hunks of revision rev2/,
			);
			await root.commit((tx) => upsertFinding(tx, root.id, cited, "rev2", proof), context);

			expect(await lifecycle(harness, old.properties.id)).toMatchObject({ status: "dismissed", proof });

			const changed = [{ file: "src/lib.ts", hash: snippetHash("+export const run = Function;") }, proof[1]!];
			await root.commit((tx) => upsertFinding(tx, root.id, cited, "rev3", changed), context);

			expect(await lifecycle(harness, old.properties.id)).toMatchObject({
				status: "new",
				history: [{ dismissedReason: dismissal.reason, reopenedRevision: "rev3" }],
				proof,
			});
		});

		it("carries the dismissal on the finding it reads", async () => {
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
			await root.commit((tx) => dismissFinding(tx, root.id, evalFinding.properties.id, dismissal), context);
			const [read] = await readFindings(harness, root.id, "rev1", context);
			expect(read!.properties).toMatchObject({ status: "dismissed", dismissal });
			expect(read!.properties.pastDismissals).toBeUndefined();
		});

		it("replaces the reason of a finding dismissed again, keeping the first in its history", async () => {
			const again = { by: "ana", reason: "  the input is a literal  ", at: "2026-10-04T00:00:00.000Z" };
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
			const first = await root.commit(
				(tx) => dismissFinding(tx, root.id, evalFinding.properties.id, dismissal),
				context,
			);
			const replaced = await root.commit(
				(tx) => dismissFinding(tx, root.id, evalFinding.properties.id, again),
				context,
			);
			expect(first).toBeUndefined();
			expect(replaced).toEqual(dismissal);
			const [read] = await readFindings(harness, root.id, "rev1", context);
			expect(read!.properties.dismissal).toEqual({ ...again, reason: "the input is a literal" });
			expect(read!.properties.pastDismissals).toEqual([{ ...dismissal, replacedAt: again.at }]);
		});

		it("refuses a blank or overlong reason and commits nothing", async () => {
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
			for (const reason of [" \n ", "x".repeat(maxDismissalReasonLength + 1)]) {
				const dismissed = root.commit(
					(tx) => dismissFinding(tx, root.id, evalFinding.properties.id, { ...dismissal, reason }),
					context,
				);
				await expect(dismissed).rejects.toMatchObject({ code: "invalidDismissal" });
			}
			expect((await lifecycle(harness, evalFinding.properties.id))?.status).toBe("new");
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
			Finding.create({ ...input, severity, resolution: "advisory", source: style });

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
			const evidenced = Finding.create({ ...input, cause: "affected", evidence, failureScenario });
			const contextOnly = [{ ...evidence[0]!, role: "context" as const }];
			const unproven = Finding.create({
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
					{
						id: unproven.properties.id,
						ruleId: "no-eval",
						source: style,
						failureScenario: "A guess.",
						evidence: contextOnly,
					},
					{ id: evidenced.properties.id, ruleId: "no-eval", source: security, failureScenario, evidence },
				],
			});
			expect(merged!.resolve(defaultConfig)).toBe("block");
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
			const corrected = Finding.create({ ...input, message: "corrected" });
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
			const old = Finding.create({
				...input,
				message: "old head",
				trigger: { file: "src/run.ts", index: 0, snippet: "a()" },
			});
			const current = Finding.create({ ...input, trigger: { file: "src/run.ts", index: 0, snippet: "b()" } });
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

describe("version 5 findings", () => {
	it("reads through version 6 after an SQLite reopen", async () => {
		const legacy = defineDoc<Legacy>({
			kind: "melian.findings",
			version: 5,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({}),
		});
		const path = join(dir, "version-five.sqlite");
		const first = await open(await openSqliteStorage(path));
		const { status: _, ...properties } = evalFinding.properties;
		await first.root.commit(async (tx) => {
			const state = await tx.doc(legacy, first.root.id);
			state.revisions = ["rev1"];
			state.items = json({
				[evalFinding.id]: {
					lifecycle: { status: "new", firstSeenRevision: "rev1", lastSeenRevision: "rev1", history: [] },
					sightings: { rev1: { "lens.security@1": { ...evalFinding.toJSON(), properties } } },
				},
			});
			state.versions = { rev1: 1 };
		}, context);
		await first.harness.close(context);
		const { harness, root } = await open(await openSqliteStorage(path));
		expect(await readFindings(harness, root.id, "rev1", context)).toEqual([seen(evalFinding)]);
	});
});

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
		const current = Finding.create({ ...input, cause: "affected", evidence });
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
		const later = Finding.create({
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
		const current = Finding.create({ ...input, cause: "affected", evidence });
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
		const current = Finding.create({ ...input, cause: "affected", evidence });
		const { role: _, revision: __, ...old } = evidence[0]!;
		const stored = { ...current, properties: { ...current.properties, evidence: old } };
		const plain = Finding.create({ ...input, snippet: "eval(body)" });
		const verdict = (finding: unknown): StoredVerdict =>
			({
				status: "findings",
				blocking: true,
				findings: { block: [finding, plain.toJSON()], acknowledge: [], advisory: [], silent: [] },
				dismissed: [],
				notRun: [],
			}) as StoredVerdict;
		// What an older Melian's fingerprint gave this verdict as stored, so both sides do not come from the code under test.
		const published = "3e32f949baf5d54e";
		const migrated = Verdict.from(Verdict.upgrade(verdict(stored)));

		expect(Verdict.from(verdict(stored)).fingerprint()).toBe(published);
		expect(migrated.fingerprint()).toBe("3f63e3f3f6c2216a");
		expect(migrated.legacyFingerprint()).toBe(published);
		const scenario = Finding.create({ ...input, cause: "affected", evidence, failureScenario: "run(1) throws." });
		expect(Verdict.from(verdict(scenario.toJSON())).legacyFingerprint()).toBeUndefined();
		const contextOnly = [{ ...evidence[0]!, role: "context" as const }];
		const contextual = Finding.create({ ...input, evidence: contextOnly }).toJSON();
		expect(Verdict.from(verdict(contextual)).legacyFingerprint()).toBeUndefined();
	});

	it("keys each reply an older Melian recorded by its finding, its thread, and the dismissal it gave", async () => {
		const path = join(dir, "legacy-replies.sqlite");
		const dismissal = { by: "Tal <tal@melian.invalid>", reason: "Constant input.", at: "2026-10-04T00:00:00Z" };
		const entry = { ruleId: "no-eval", path: "src/run.ts", line: 12, revision: "head" };
		const first = await open(await openSqliteStorage(path));
		await first.root.commit(async (tx) => {
			const published = await tx.doc(LegacyPublished, first.root.id);
			published.order = ["head"];
			published.revisions = json({
				head: {
					reviews: ["101"],
					open: {},
					resolved: {
						aaaaaaaaaaaaaaaa: { ...entry, thread: "9" },
						bbbbbbbbbbbbbbbb: { ...entry, thread: "11", dismissal },
						cccccccccccccccc: entry,
					},
					replies: { aaaaaaaaaaaaaaaa: "10", bbbbbbbbbbbbbbbb: null },
				},
			});
		}, context);
		await first.harness.close(context);

		const { harness, root } = await open(await openSqliteStorage(path));
		const published = await harness.snapshot(PublishedDocument, root.id, context);
		expect(published?.revisions.head?.replies).toEqual({
			[replyKey("aaaaaaaaaaaaaaaa", "9")]: "10",
			[replyKey("bbbbbbbbbbbbbbbb", "11", dismissalVersion(dismissal))]: null,
		});
	});

	describe("publishing a head once per revision, across the upgrade", () => {
		const head = "a".repeat(40);
		const baseA = "b".repeat(40);
		const baseB = "c".repeat(40);
		const repository = { owner: "melian-agent", name: "example" };
		const evidence = [
			{ file: "src/api.ts", startLine: 3, role: "cause" as const, revision: "head" as const, snippet: "run(body)" },
		];
		const current = Finding.create({ ...input, cause: "affected", evidence });
		const { role: _, revision: __, ...old } = evidence[0]!;
		const stored = { ...current, properties: { ...current.properties, evidence: old } };
		// The verdict as an older Melian recorded it, for A..H and, identically, for B..H after a retarget.
		const oldVerdict = {
			status: "findings",
			blocking: true,
			findings: { block: [stored], acknowledge: [], advisory: [], silent: [] },
			dismissed: [],
			notRun: [],
		};
		// What an older Melian's fingerprint gave `oldVerdict`, and the review it posted records.
		const oldFingerprint = "b03f395c48ffe2ed";
		const provenance = (base: string) => ({
			kind: "pull-request" as const,
			repository,
			pullRequest: 7,
			base,
			head,
			policy: `revision:${base}`,
			manifest: [] as string[],
			lenses: [] as string[],
		});

		function fakeProvider(base: string) {
			const posted: ReviewDraft[] = [];
			const pullRequest: PullRequest = {
				repository,
				number: 7,
				title: "t",
				url: "https://github.com/melian-agent/example/pull/7",
				state: "open",
				base: { ref: "main", sha: base },
				head: { ref: "feature", sha: head },
				fetch: { url: "https://github.com/melian-agent/example.git", headRef: "refs/pull/7/head" },
			};
			const provider: ReviewProvider = {
				name: "fake",
				pullRequest: async () => pullRequest,
				postReview: async (draft) => {
					posted.push(draft);
					return { id: String(200 + posted.length), threads: {} };
				},
				replyResolved: async () => undefined,
				setStatus: async () => undefined,
				findPublished: async () => ({ threads: {}, replies: {} }),
			};
			return { provider, posted, pullRequest };
		}

		// Writes what the older Melian left: A..H's review posted under its verdict's fingerprint, and the verdicts of
		// `reviewed`, then publishes `base`..H with the current Melian.
		async function publishAfterUpgrade(reviewed: string[], base: string) {
			const path = join(dir, "legacy-published.sqlite");
			const first = await open(await openSqliteStorage(path));
			await first.root.commit(async (tx) => {
				const verdicts = await tx.doc(LegacyVerdicts, first.root.id);
				verdicts.verdicts = json(Object.fromEntries(reviewed.map((each) => [`${each}..${head}`, oldVerdict])));
				verdicts.provenance = json(
					Object.fromEntries(reviewed.map((each) => [`${each}..${head}`, provenance(each)])),
				);
				const published = await tx.doc(LegacyPublished, first.root.id);
				published.order = [head];
				published.revisions = json({
					[head]: {
						reviews: ["101"],
						verdict: oldFingerprint,
						rounds: 1,
						open: {},
						resolved: {},
						replies: {},
						status: { state: "failure", description: "1 finding, 1 blocking" },
					},
				});
				(await tx.doc(PublisherDocument, first.root.id)).secret = "11".repeat(32);
			}, context);
			await first.harness.close(context);

			const { provider, posted, pullRequest } = fakeProvider(base);
			const publisher = await openPublishHarness(await openSqliteStorage(path), createFakeModels().review, provider);
			try {
				const changeset = { revision: Revision.from({ base, head, files: [] }) } as unknown as Changeset;
				const publication = await publishReview({
					harness: publisher.harness,
					provider,
					changeset,
					pullRequest,
					base,
				});
				return { publication, posted };
			} finally {
				await publisher.close();
			}
		}

		it("fingerprints the old verdict, and its upgrade's legacy form, as an older Melian did", () => {
			const stored = oldVerdict as unknown as StoredVerdict;
			expect(Verdict.from(stored).fingerprint()).toBe(oldFingerprint);
			expect(Verdict.from(Verdict.upgrade(stored)).legacyFingerprint()).toBe(oldFingerprint);
		});

		it("posts nothing again for the revision that review was of", async () => {
			const { publication, posted } = await publishAfterUpgrade([baseA], baseA);
			expect(posted).toEqual([]);
			expect(publication.review).toBe("101");
		});

		it("posts a review of a retargeted revision whose verdict matches the one published under the old base", async () => {
			const path = join(dir, "published.sqlite");
			const verdict = Verdict.upgrade(oldVerdict as unknown as StoredVerdict);
			const first = await open(await openSqliteStorage(path));
			await first.root.commit(async (tx) => {
				const verdicts = await tx.doc(VerdictDocument, first.root.id);
				for (const base of [baseA, baseB]) {
					verdicts.verdicts[`${base}..${head}`] = verdict;
					verdicts.provenance = {
						...verdicts.provenance,
						[`${base}..${head}`]: provenance(base),
					};
				}
				(await tx.doc(PublisherDocument, first.root.id)).secret = "11".repeat(32);
			}, context);
			await first.harness.close(context);
			const publishAt = async (base: string) => {
				const { provider, posted, pullRequest } = fakeProvider(base);
				const publisher = await openPublishHarness(
					await openSqliteStorage(path),
					createFakeModels().review,
					provider,
				);
				try {
					const changeset = { revision: Revision.from({ base, head, files: [] }) } as unknown as Changeset;
					await publishReview({ harness: publisher.harness, provider, changeset, pullRequest, base });
					return posted;
				} finally {
					await publisher.close();
				}
			};

			expect(await publishAt(baseA)).toHaveLength(1);
			expect(await publishAt(baseA)).toEqual([]);
			expect(await publishAt(baseB)).toHaveLength(1);
		});

		it("posts a review of a retargeted revision whose verdict an older Melian recorded identically", async () => {
			const { publication, posted } = await publishAfterUpgrade([baseA, baseB], baseB);
			expect(posted).toHaveLength(1);
			expect(posted[0]).toMatchObject({ revision: head, base: baseB });
			expect(publication.review).toBe("201");
		});
	});
});
