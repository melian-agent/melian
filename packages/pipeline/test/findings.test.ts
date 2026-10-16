import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Adjudication,
	Changeset,
	defaultConfig,
	dismissalVersion,
	evaluateGuardrails,
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
import { FindingsDocument, findingsVersion, seenBefore, upsertVerification } from "../src/findings.ts";
import { PublishedDocument, PublisherDocument } from "../src/publish.ts";
import { baseAndHead, lines } from "./fixtures/repo.ts";

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

	it.each(["confirmed", "plausible", "refuted"] as const)(
		"clears a %s verdict when a lens replaces its sighting",
		async (verdict) => {
			const { harness, root } = await open(createMemoryStorage());
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
			await root.commit(
				(tx) =>
					upsertVerification(tx, root.id, "rev1", evalFinding.id, input.source, {
						verdict,
						reason: "Traced the original claim.",
						executor: "llm",
						model: "fake/judge",
						version: "1",
					}),
				context,
			);
			expect((await readFindings(harness, root.id, "rev1", context))[0]!.properties.verification?.verdict).toBe(
				verdict,
			);
			const reworded = Finding.create({ ...input, message: "eval runs the request body" });
			expect(reworded.id).toBe(evalFinding.id);
			await root.commit((tx) => upsertFinding(tx, root.id, reworded, "rev1"), context);
			const state = (await harness.snapshot(FindingsDocument, root.id, context))!;
			expect(state.items[evalFinding.id]!.verifications?.rev1).toEqual({});
			const findings = await readFindings(harness, root.id, "rev1", context);
			expect(findings).toEqual([seen(reworded)]);
			expect(findings[0]!.properties.verification).toBeUndefined();
		},
	);
	it.each(["confirmed", "plausible", "refuted"] as const)(
		"replays an identical %s verification without changing the findings version",
		async (verdict) => {
			const { harness, root } = await open(createMemoryStorage());
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
			const before = await findingsVersion(harness, root.id, "rev1", context);
			const verification: Verification = {
				verdict,
				reason: "Traced the code.",
				correction: "Use the guarded value.",
				executor: "llm",
				model: "fake/judge",
				version: "1",
			};
			await root.commit(
				(tx) => upsertVerification(tx, root.id, "rev1", evalFinding.id, input.source, verification),
				context,
			);
			const version = await findingsVersion(harness, root.id, "rev1", context);
			expect(version).toBe(before + 1);
			const findings = await readFindings(harness, root.id, "rev1", context);
			expect(findings[0]!.properties.verification).toEqual(verification);
			await root.commit(
				(tx) => upsertVerification(tx, root.id, "rev1", evalFinding.id, input.source, { ...verification }),
				context,
			);
			expect(await findingsVersion(harness, root.id, "rev1", context)).toBe(version);
			expect(await readFindings(harness, root.id, "rev1", context)).toEqual(findings);
		},
	);
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

		it("holds a versionless producer to its IDs across every version of its check", async () => {
			const { harness, root } = await open(createMemoryStorage());
			const versionless = { check: security.check };
			const older = Finding.create({ ...input, rule: "older-eval", source: versionless });
			await root.commit(async (tx) => {
				await upsertFinding(tx, root.id, older, "rev1");
				await upsertFinding(tx, root.id, evalFinding, "rev1");
			}, context);

			for (const finding of [older, evalFinding]) {
				const read = await readFindings(harness, root.id, "rev1", context, {
					producers: [{ ...versionless, ids: [finding.properties.id] }],
				});
				expect(read).toEqual([seen(finding)]);
			}
			expect(
				await readFindings(harness, root.id, "rev1", context, {
					producers: [{ ...versionless, ids: [] }, security],
				}),
			).toEqual([seen(evalFinding)]);
		});

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

describe("version 6 findings and verdicts", () => {
	const recorded = JSON.parse(readFileSync(new URL("./fixtures/stored-v6/review.json", import.meta.url), "utf8")) as {
		revision: string;
		findings: Legacy;
		verdicts: Legacy & { verdicts: Record<string, StoredVerdict> };
	};
	const legacy = (kind: string) =>
		defineDoc<Legacy>({
			kind,
			version: 6,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({}),
		});

	it("reads what version 6 wrote after an SQLite reopen, then lowers its finding and reads that after another", async () => {
		const path = join(dir, "version-six.sqlite");
		const first = await open(await openSqliteStorage(path));
		await first.root.commit(async (tx) => {
			Object.assign(await tx.doc(legacy("melian.findings"), first.root.id), recorded.findings);
			Object.assign(await tx.doc(legacy("melian.verdicts"), first.root.id), recorded.verdicts);
		}, context);
		await first.harness.close(context);

		const second = await open(await openSqliteStorage(path));
		const { revision } = recorded;
		const [finding] = await readFindings(second.harness, second.root.id, revision, context);
		expect(finding!.properties).toMatchObject({ severity: "P1", cause: "introduced" });
		expect(finding!.properties.originalSeverity).toBeUndefined();
		expect(finding!.properties.verification).toEqual({
			verdict: "confirmed",
			reason: "Traced the code.",
			correction: "Use the guarded value.",
			executor: "llm",
			model: "faux/judge",
			version: "6e135e83e4a4679e",
		});
		const verdict = (await readVerdict(second.harness, second.root.id, revision, context))!;
		expect(verdict.findings.block.map((each) => each.id)).toEqual([finding!.id]);
		expect(verdict.preExistingImportant).toBeUndefined();
		// The stored JSON of a verdict without dismissals is what its fingerprint hashes, so the new code adds nothing to it.
		const stored = JSON.stringify(recorded.verdicts.verdicts[revision]);
		expect(verdict.fingerprint()).toBe(createHash("sha256").update(stored).digest("hex").slice(0, 16));

		const lowered = { from: "P1", to: "P2", reason: "The only caller validates." } as const;
		await second.root.commit(
			(tx) =>
				upsertVerification(tx, second.root.id, revision, finding!.id, finding!.properties.source, {
					...finding!.properties.verification!,
					// A later verifier's record, since an equal report from the same one could not lower.
					version: "next",
					answers: { code: "yes", guard: "no", base: "no" },
					lowered,
				}),
			context,
		);
		await second.harness.close(context);

		const third = await open(await openSqliteStorage(path));
		const [again] = await readFindings(third.harness, third.root.id, revision, context);
		expect(again!.properties).toMatchObject({ severity: "P2", originalSeverity: "P1" });
		expect(again!.properties.verification?.lowered).toEqual(lowered);
		expect(await readVerdict(third.harness, third.root.id, revision, context)).toEqual(verdict);
	});
});

describe("version 7 findings and verdicts", () => {
	const recorded = JSON.parse(readFileSync(new URL("./fixtures/stored-v7/review.json", import.meta.url), "utf8")) as {
		revision: string;
		findings: Legacy & { items: Record<string, unknown> };
		verdicts: Legacy & { verdicts: Record<string, StoredVerdict> };
	};
	const legacy = (kind: string) =>
		defineDoc<Legacy>({
			kind,
			version: 7,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({}),
		});
	// The rule-level key applies only to a sighting that names its rules; the whole guardrail's applies to any.
	const keyed = {
		resolution: defaultConfig.resolution,
		layers: [
			{
				file: "melian.yaml",
				resolution: {
					checks: {
						guardrails: {
							rules: {
								"guardrail/forbidden-patterns": { P2: "advisory" },
								"guardrail/forbidden-patterns/focused-test": { P2: "block" },
							},
						},
					},
				},
			},
		],
	} as const;
	// The two commits the recording reviewed, built again.
	const policy = lines(
		"tiers:",
		"  full: [guardrails]",
		"guardrails:",
		"  forbidden-patterns:",
		"    rules:",
		'      focused-test: { pattern: "\\\\bit\\\\.only\\\\(", message: Remove the focused test. }',
		'      console-log: { pattern: "console\\\\.log", message: Remove the console.log., severity: P3 }',
	);
	async function guardrailsToday(): Promise<Finding[]> {
		const repo = baseAndHead(
			{ "melian.yaml": policy, "biome.json": "{}\n", "src/a.test.ts": "export const a = 1;\n" },
			{
				"melian.yaml": `${policy}resolution:\n  P3: silent\n`,
				"biome.json": '{ "linter": { "enabled": false } }\n',
				"src/a.test.ts": 'export const a = 1;\nit.only("logs", () => console.log(a));\n',
			},
		);
		try {
			const { revision } = await Changeset.resolve(repo, "main...feature");
			const source = { kind: "revision", commit: revision.base } as const;
			return [...(await evaluateGuardrails({ repoRoot: repo, revision, source })).findings];
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}

	it("refuses a version-8 findings document opened by a version-7 definition", async () => {
		const { harness, root } = await open(createMemoryStorage());
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		await expect(harness.snapshot(legacy("melian.findings"), root.id, context)).rejects.toThrow(
			/newer version 8 than 7/,
		);
	});

	it("reads what version 7 wrote after an SQLite reopen, then keys its guardrail sighting and reads that after another", async () => {
		const path = join(dir, "version-seven.sqlite");
		const first = await open(await openSqliteStorage(path));
		await first.root.commit(async (tx) => {
			Object.assign(await tx.doc(legacy("melian.findings"), first.root.id), recorded.findings);
			Object.assign(await tx.doc(legacy("melian.verdicts"), first.root.id), recorded.verdicts);
		}, context);
		await first.harness.close(context);

		const second = await open(await openSqliteStorage(path));
		const { revision } = recorded;
		const stored = await readFindings(second.harness, second.root.id, revision, context);
		expect(stored.map((each) => each.ruleId).sort()).toEqual([
			"guardrail/forbidden-patterns",
			"guardrail/policy-change-review",
			"guardrail/policy-change-review",
		]);
		expect(stored.map((each) => each.properties.guardrail)).toEqual([undefined, undefined, undefined]);
		const pattern = stored.find((each) => each.ruleId === "guardrail/forbidden-patterns")!;
		expect(pattern.resolve(keyed)).toBe("advisory");
		const verdict = (await readVerdict(second.harness, second.root.id, revision, context))!;
		expect(verdict.findings.acknowledge.map((each) => each.id)).toContain(pattern.id);
		expect(verdict.all().map((each) => each.properties.decidedBy)).toEqual([undefined, undefined, undefined]);
		// The stored JSON of a verdict without dismissals is what its fingerprint hashes, so the new code adds nothing to it.
		const json = JSON.stringify(recorded.verdicts.verdicts[revision]);
		expect(verdict.fingerprint()).toBe(createHash("sha256").update(json).digest("hex").slice(0, 16));

		// No stored finding changes identity: today's guardrails give the same IDs, and name what each matched.
		const today = await guardrailsToday();
		expect(today.map((each) => each.id).sort()).toEqual(Object.keys(recorded.findings.items).sort());
		const again = today.find((each) => each.id === pattern.id)!;
		expect(again.properties.guardrail).toEqual({ rules: ["focused-test", "console-log"] });
		await second.root.commit((tx) => upsertFinding(tx, second.root.id, again, revision), context);
		await second.harness.close(context);

		const third = await open(await openSqliteStorage(path));
		const reread = await readFindings(third.harness, third.root.id, revision, context);
		expect(reread).toHaveLength(3);
		const rekeyed = reread.find((each) => each.id === pattern.id)!;
		expect(rekeyed.properties.guardrail).toEqual({ rules: ["focused-test", "console-log"] });
		expect(rekeyed.resolve(keyed)).toBe("block");
		expect(await readVerdict(third.harness, third.root.id, revision, context)).toEqual(verdict);
	});
});

describe("lowered sightings", () => {
	const record: Verification = {
		verdict: "confirmed",
		reason: "Traced.",
		executor: "llm",
		model: "fake/judge",
		version: "1",
	};
	const lowered: Verification = { ...record, lowered: { from: "P1", to: "P2", reason: "One caller validates." } };
	const judge = (root: Awaited<ReturnType<typeof open>>["root"], verification: Verification, source = input.source) =>
		root.commit((tx) => upsertVerification(tx, root.id, "rev1", evalFinding.id, source, verification), context);

	it("reads a lowered sighting at the lowered severity, and leaves the lens's severity stored", async () => {
		const { harness, root } = await open(createMemoryStorage());
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		await judge(root, lowered);
		const [finding] = await readFindings(harness, root.id, "rev1", context);
		expect(finding!.properties).toMatchObject({ severity: "P2", originalSeverity: "P1" });
		expect(finding!.level).toBe("warning");
		const state = (await harness.snapshot(FindingsDocument, root.id, context))!;
		const stored = state.items[evalFinding.id]!.sightings.rev1!["lens.security@1"]!;
		expect(stored.properties.severity).toBe("P1");
		expect(stored.level).toBe("error");
		expect(stored.properties).not.toHaveProperty("originalSeverity");
	});

	it("takes the highest severity among sightings of one ID after lowering, and names the original", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const other = { check: "lens.contracts", version: "1" };
		const second = Finding.create({ ...input, severity: "P2", source: other, failureScenario: "It fails." });
		const third = Finding.create({ ...input, severity: "P3", source: { check: "lens.tests", version: "1" } });
		const first = Finding.create({ ...input, failureScenario: "eval('1') runs." });
		await root.commit((tx) => upsertFinding(tx, root.id, first, "rev1"), context);
		await root.commit((tx) => upsertFinding(tx, root.id, third, "rev1"), context);
		await judge(root, lowered);
		const [alone] = await readFindings(harness, root.id, "rev1", context);
		expect(alone!.properties).toMatchObject({ severity: "P2", originalSeverity: "P1" });
		expect(alone!.properties.source.check).toBe("lens.security");
		await root.commit((tx) => upsertFinding(tx, root.id, second, "rev1"), context);
		const [tied] = await readFindings(harness, root.id, "rev1", context);
		expect(tied!.properties).toMatchObject({ severity: "P2", originalSeverity: "P1" });
		expect(tied!.properties.source.check).toBe("lens.contracts");
		expect(tied!.lowered()).toEqual({ from: "P1", reason: "One caller validates." });
	});

	// Codex's H1 on pull request 131: the refuted sighting must not speak through the one that stands.
	it("speaks through a standing sighting of one ID, with its own severity and prose, never a refuted one", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const other = { check: "lens.contracts", version: "1" };
		const standing = Finding.create({ ...input, severity: "P2", source: other, failureScenario: "It fails." });
		// A claim needs a failure scenario or evidence for a verdict to refute it.
		const refuted = Finding.create({ ...input, failureScenario: "eval('1') runs." });
		await root.commit((tx) => upsertFinding(tx, root.id, refuted, "rev1"), context);
		await root.commit((tx) => upsertFinding(tx, root.id, standing, "rev1"), context);
		await judge(root, { ...record, verdict: "refuted" });
		await judge(root, record, other);
		const [judged] = await readFindings(harness, root.id, "rev1", context);
		expect(judged!.properties).toMatchObject({ severity: "P2", source: other, failureScenario: "It fails." });
		expect(judged!.level).toBe("warning");
		// The order grouping reads is the lenses' own, refuted or not.
		expect(judged!.original()).toBe("P1");
		// As reported, before anything judges it, no verdict picks the winner, so a repeat review's candidate is unchanged.
		const [reported] = await readFindings(harness, root.id, "rev1", context, { asReported: true });
		expect(reported!.properties).toMatchObject({ severity: "P1", source: input.source });
	});

	// The round's 9acf210b: refuting one lens's sighting must not change the severity the merge orders by.
	it("keeps the severity the lenses reported, refuted sightings included, as the order grouping reads", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const tests = { check: "lens.tests", version: "1" };
		const claim = { failureScenario: "eval('1') runs." };
		await root.commit((tx) => upsertFinding(tx, root.id, Finding.create({ ...input, ...claim }), "rev1"), context);
		const low = Finding.create({ ...input, ...claim, severity: "P3", source: tests });
		await root.commit((tx) => upsertFinding(tx, root.id, low, "rev1"), context);
		await judge(root, { ...record, verdict: "refuted" });
		await judge(root, record, tests);
		for (const asReported of [false, true]) {
			const [finding] = await readFindings(harness, root.id, "rev1", context, { asReported });
			expect(finding!.original()).toBe("P1");
		}
	});

	// The round's faabb218 and 3448ebab: one ID, two sightings on different lines. A refutation must not move the finding.
	it.each([
		{ scenario: "a blank line on either side", design: [5, 6], tests: [6, 7], snippet: ["\nfoo()", "foo()\n"] },
		{ scenario: "one added hunk", design: [6, 6], tests: [5, 6], snippet: ["return value;", "\nreturn value;"] },
	] as const)(
		"keeps the lines the lenses' winner reported after a refutation, with $scenario",
		async ({ design, tests, snippet }) => {
			const { harness, root } = await open(createMemoryStorage());
			const source = { check: "lens.design", version: "1" };
			const other = { check: "lens.tests", version: "1" };
			const sighting = (
				lines: readonly [number, number],
				text: string,
				severity: "P1" | "P2",
				from: FindingSource,
			) =>
				Finding.create({
					...input,
					startLine: lines[0],
					endLine: lines[1],
					startColumn: undefined,
					endColumn: undefined,
					snippet: text,
					severity,
					source: from,
					failureScenario: `${from.check} scenario.`,
				});
			const [first, second] = [sighting(design, snippet[0], "P1", source), sighting(tests, snippet[1], "P2", other)];
			expect(first.id).toBe(second.id);
			await root.commit((tx) => upsertFinding(tx, root.id, first, "rev1"), context);
			await root.commit((tx) => upsertFinding(tx, root.id, second, "rev1"), context);
			const verdictOn = (verification: Verification, from: FindingSource) =>
				root.commit((tx) => upsertVerification(tx, root.id, "rev1", first.id, from, verification), context);
			await verdictOn({ ...record, verdict: "refuted" }, source);
			await verdictOn(record, other);
			const [reported] = await readFindings(harness, root.id, "rev1", context, { asReported: true });
			const [judged] = await readFindings(harness, root.id, "rev1", context);
			expect(reported!.lines()).toEqual([...design]);
			expect(judged!.lines()).toEqual(reported!.lines());
			// The refutation still decides what it resolves at and says.
			expect(judged!.properties).toMatchObject({ severity: "P2", failureScenario: "lens.tests scenario." });
		},
	);

	it("keeps the lines the lenses' winner reported after a lowering ties it with another sighting", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const design = { check: "lens.design", version: "1" };
		const tests = { check: "lens.tests", version: "1" };
		const sighting = (start: number, text: string, severity: "P1" | "P2", from: FindingSource) =>
			Finding.create({
				...input,
				startLine: start,
				endLine: start + 1,
				startColumn: undefined,
				endColumn: undefined,
				snippet: text,
				severity,
				source: from,
				failureScenario: `${from.check} scenario.`,
			});
		// The tests lens reported the P1, so its lines stand, though the lowering ties it with design's, which sorts first.
		const [first, second] = [sighting(5, "\nfoo()", "P2", design), sighting(6, "foo()\n", "P1", tests)];
		expect(first.id).toBe(second.id);
		await root.commit((tx) => upsertFinding(tx, root.id, first, "rev1"), context);
		await root.commit((tx) => upsertFinding(tx, root.id, second, "rev1"), context);
		await root.commit((tx) => upsertVerification(tx, root.id, "rev1", first.id, tests, lowered), context);
		const [reported] = await readFindings(harness, root.id, "rev1", context, { asReported: true });
		const [judged] = await readFindings(harness, root.id, "rev1", context);
		expect(reported!.lines()).toEqual([6, 7]);
		expect(judged!.lines()).toEqual([6, 7]);
	});

	it("reads a finding whose every sighting a verifier refuted, at the most severe of them", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const other = { check: "lens.contracts", version: "1" };
		const claim = { failureScenario: "eval('1') runs." };
		await root.commit((tx) => upsertFinding(tx, root.id, Finding.create({ ...input, ...claim }), "rev1"), context);
		const second = Finding.create({ ...input, ...claim, severity: "P2", source: other });
		await root.commit((tx) => upsertFinding(tx, root.id, second, "rev1"), context);
		await judge(root, { ...record, verdict: "refuted" });
		await judge(root, { ...record, verdict: "refuted" }, other);
		const [finding] = await readFindings(harness, root.id, "rev1", context);
		expect(finding!.properties).toMatchObject({ severity: "P1", source: input.source });
		expect(finding!.refuted()).toBe(true);
	});

	it("drops the original severity when an unlowered sighting holds the finding at it", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const other = { check: "lens.contracts", version: "1" };
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		await root.commit(
			(tx) => upsertFinding(tx, root.id, Finding.create({ ...input, source: other }), "rev1"),
			context,
		);
		await judge(root, lowered);
		const [finding] = await readFindings(harness, root.id, "rev1", context);
		expect(finding!.properties.severity).toBe("P1");
		expect(finding!.properties.originalSeverity).toBeUndefined();
	});

	it("leaves a claim unlowered when an equal report disagrees, in either order, and on replay", async () => {
		const weaker = lowered;
		for (const order of [
			[weaker, record],
			[record, weaker],
		]) {
			const { harness, root } = await open(createMemoryStorage());
			await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
			for (const report of order) {
				await judge(root, report);
				const version = await findingsVersion(harness, root.id, "rev1", context);
				await judge(root, { ...report });
				expect(await findingsVersion(harness, root.id, "rev1", context)).toBe(version);
			}
			const [finding] = await readFindings(harness, root.id, "rev1", context);
			expect(finding!.properties.verification).toEqual(record);
			expect(finding!.properties).toMatchObject({ severity: "P1", cause: "introduced" });
			const version = await findingsVersion(harness, root.id, "rev1", context);
			await judge(root, order[0]!);
			expect(await findingsVersion(harness, root.id, "rev1", context)).toBe(version);
			expect((await readFindings(harness, root.id, "rev1", context))[0]!.properties.verification).toEqual(record);
		}
	});

	it("keeps the acknowledgement of a pre-existing finding at the next revision, so a preExisting cap asks once", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const old = Finding.create({ ...input, severity: "P0", cause: "pre-existing", resolution: undefined });
		const capped = {
			resolution: {
				...defaultConfig.resolution,
				preExisting: { ...defaultConfig.resolution.preExisting, P0: "acknowledge" },
			},
			ruleAliases: {},
		} as const;
		const decide = async (revision: string) =>
			new Adjudication({
				findings: await readFindings(harness, root.id, revision, context),
				manifest: [],
				checks: [],
				config: capped,
				seenBefore: await seenBefore(harness, root.id, revision, context),
			}).adjudicate();
		await root.commit((tx) => upsertFinding(tx, root.id, old, "rev1"), context);
		const first = await decide("rev1");
		expect(first.status).toBe("findings");
		expect(first.findings.acknowledge.map((each) => each.id)).toEqual([old.id]);
		expect(first.preExistingImportant).toMatchObject([{ id: old.id, state: "new" }]);

		await root.commit((tx) => upsertFinding(tx, root.id, old, "rev2"), context);
		const carried = await decide("rev2");
		expect(carried.findings.acknowledge.map((each) => each.id)).toEqual([old.id]);
		expect(carried.preExistingImportant).toMatchObject([{ id: old.id, state: "carried" }]);

		// The maintainer's answer is a dismissal, kept by finding ID, so the next revision does not ask again.
		const answer = { by: "tal", reason: "Tracked for the next release.", at: "2026-10-13T00:00:00.000Z" };
		await root.commit((tx) => dismissFinding(tx, root.id, old.id, answer), context);
		await root.commit((tx) => upsertFinding(tx, root.id, old, "rev3"), context);
		const answered = await decide("rev3");
		expect(answered.status).toBe("passed");
		expect(answered.dismissed.map((each) => each.id)).toEqual([old.id]);
		expect(answered.preExistingImportant).toBeUndefined();
	});

	it("drops a producer's own claim to a lowering or to a held resolution", async () => {
		const { harness, root } = await open(createMemoryStorage());
		const claimed = Finding.from({
			...evalFinding.toJSON(),
			properties: { ...evalFinding.properties, originalSeverity: "P0", resolvedAtOriginal: true },
		});
		await root.commit((tx) => upsertFinding(tx, root.id, claimed, "rev1"), context);
		const state = (await harness.snapshot(FindingsDocument, root.id, context))!;
		const stored = state.items[evalFinding.id]!.sightings.rev1!["lens.security@1"]!;
		expect(stored.properties).not.toHaveProperty("originalSeverity");
		expect(stored.properties).not.toHaveProperty("resolvedAtOriginal");
		const [finding] = await readFindings(harness, root.id, "rev1", context);
		expect(finding!.original()).toBe("P1");
		expect(finding!.important()).toBe(false);
	});

	it("names a finding as seen before only at a revision after the one that first sighted it", async () => {
		const { harness, root } = await open(createMemoryStorage());
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev1"), context);
		expect(await seenBefore(harness, root.id, "rev1", context)).toEqual([]);
		await root.commit((tx) => upsertFinding(tx, root.id, evalFinding, "rev2"), context);
		const fresh = Finding.create({ ...input, snippet: "eval(body)" });
		await root.commit((tx) => upsertFinding(tx, root.id, fresh, "rev2"), context);
		expect(await seenBefore(harness, root.id, "rev2", context)).toEqual([evalFinding.id]);
		expect(await seenBefore(harness, root.id, "rev1", context)).toEqual([fresh.id]);
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
		expect(published?.revisions.head?.publishedBy).toEqual({ trustedWriters: true });
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
				login: async () => undefined,
				permission: async () => undefined,
				name: "fake",
				findLedger: async () => undefined,
				writeLedger: async () => ({
					id: "ledger",
					url: "https://example.test/ledger",
					stamp: {
						version: 1,
						base,
						head,
						round: 1,
						verdict: "0".repeat(16),
						counts: { open: 0, blocking: 0, dismissed: 0 },
						lenses: [],
						plan: null,
						projection: "0".repeat(16),
					},
				}),
				pullRequest: async () => pullRequest,
				postReview: async (draft) => {
					posted.push(draft);
					return { id: String(200 + posted.length), threads: {} };
				},
				replyResolved: async () => undefined,
				resolveThread: async () => false,
				setStatus: async () => undefined,
				getStatus: async () => undefined,
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
					trustedWriters: true,
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
					await publishReview({
						trustedWriters: true,
						harness: publisher.harness,
						provider,
						changeset,
						pullRequest,
						base,
					});
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
