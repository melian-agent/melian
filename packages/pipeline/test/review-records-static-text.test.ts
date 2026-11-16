import { createHash } from "node:crypto";
import {
	Changeset,
	defaultConfig,
	type EnolaSnapshot,
	Finding,
	KeyedRequest,
	normaliseEnolaSarif,
	normaliseMutationReport,
	type SharedRecord,
	type StoredFinding,
	staticFindings,
	type ToolLog,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckRunRecord } from "../src/checks.ts";
import { DismissError } from "../src/errors.ts";
import { type DismissalFacts, ReviewRecords, withheld } from "../src/review-records.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

// Text a static tool wrote that the head's tree does not hold, such as a login the head led it to read.
const token = "melian-test-token-9c4a71";
const bytes = (record: SharedRecord) => JSON.stringify(record.toJSON());
// A check run's request under this build, whose Enola check stores no tool text.
const enolaRun = KeyedRequest.of("check", { checks: { "static.enola": 2 } });

let repo: string;
beforeEach(() => {
	repo = createRepository();
});
afterEach(() => removeRepository(repo));

const path = "src/widget.ts";
const source = lines(
	"export function widget(label: string, x: boolean) {",
	'  if (label === "a" || x) return 1;',
	"  return 0;",
	"}",
);

async function findingsOf(
	tool: "enola" | "mutation",
	head: ToolLog,
	files: Record<string, string> = { [path]: source },
) {
	const base = commit(repo, { "src/other.ts": "export const x = 1;\n" });
	const commitHead = commit(repo, files);
	const { revision } = await Changeset.resolve(repo, `${base}..${commitHead}`);
	const empty: ToolLog = { ...head, runs: [{ ...head.runs[0], results: [] }] };
	const { findings } = await staticFindings({
		repoRoot: repo,
		revision,
		tool,
		settings: tool === "enola" ? defaultConfig.static.enola : defaultConfig.static.mutation,
		base: empty,
		head,
	});
	return {
		stored: findings.map((finding) => finding.toJSON()),
		records: ReviewRecords.of("c".repeat(64), { base, head: commitHead }),
		revision: `${base}..${commitHead}`,
	};
}

const ran = (name: string, findings: number, version?: string): Extract<CheckRunRecord, { status: "ran" }> => ({
	name,
	status: "ran",
	findings,
	notes: [],
	...(version === undefined ? {} : { version }),
});

function enola(results: unknown[], files?: Record<string, string>) {
	const log = normaliseEnolaSarif(
		JSON.stringify({ version: "2.1.0", runs: [{ results }] }),
		{
			root: repo,
			version: "0.4.37",
		},
		new Set(["god-class", "constraints/layer"]),
	);
	return findingsOf("enola", log, files);
}

function mutation(mutants: Record<string, unknown>[], testFiles?: Record<string, unknown>) {
	const report = JSON.stringify({
		schemaVersion: "1.0",
		config: { ignoreStatic: false, vitest: { related: true } },
		files: { [path]: { language: "typescript", source: "", mutants } },
		...(testFiles === undefined ? {} : { testFiles }),
	});
	const { log } = normaliseMutationReport(report, {
		version: "10.0.0",
		lines: { [path]: [[1, 4]] },
		tests: { [path]: `test/${token}-nearest.test.ts` },
	});
	return findingsOf("mutation", log);
}

const mutant = (extra: Record<string, unknown>) => ({
	id: "1",
	mutatorName: "LogicalOperator",
	status: "Survived",
	location: { start: { line: 2, column: 6 }, end: { line: 2, column: 27 } },
	replacement: "true",
	...extra,
});

const at = (uri: string) => [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }];

describe("an exported record holds no text Enola or the mutation check wrote", () => {
	it("as Enola's message on a located finding", async () => {
		const { stored, records } = await enola([
			{ ruleId: "god-class", level: "warning", message: { text: `widget holds ${token}` }, locations: at(path) },
		]);
		expect(stored[0]!.message.text).toContain(token);
		expect(bytes(records.check("e".repeat(64), ran("static.enola", 1, "0.4.37"), stored))).not.toContain(token);
	});

	it("as Enola's message on a finding with no code to go by", async () => {
		const { stored, records } = await enola([
			{ ruleId: "constraints/layer", level: "error", message: { text: `core reaches ${token}` } },
		]);
		expect(stored[0]!.properties.path).toBe("enola-intent.yaml");
		expect(bytes(records.check("e".repeat(64), ran("static.enola", 1, "0.4.37"), stored))).not.toContain(token);
	});

	it("as a mutant's replacement, its mutator, and the tests named to kill it", async () => {
		const { stored, records } = await mutation(
			[mutant({ mutatorName: `${token}Mutator`, replacement: `"${token}"`, static: true, coveredBy: ["t1"] })],
			{ [`test/${token}-covering.test.ts`]: { tests: [{ id: "t1", name: "covers" }] } },
		);
		expect(stored[0]!.message.text).toContain(token);
		expect(stored[0]!.properties.explanation!.whatToDo).toContain(token);
		expect(bytes(records.check("e".repeat(64), ran("static.mutation", 1, "10.0.0"), stored))).not.toContain(token);
	});

	it("as an ignored mutant's reason", async () => {
		const { stored, records } = await mutation([mutant({ status: "Ignored", statusReason: token })]);
		expect(stored[0]!.ruleId).toBe("mutation/ignored-mutant");
		expect(bytes(records.check("e".repeat(64), ran("static.mutation", 1, "10.0.0"), stored))).not.toContain(token);
	});

	it("as Enola's rule ID, in a check's sightings", async () => {
		const { stored, records } = await enola([
			{ ruleId: `layer/${token}`, level: "error", message: { text: "core reaches pipeline" } },
			{ ruleId: `wide/${token}`, level: "warning", message: { text: "widget is wide" }, locations: at(path) },
		]);
		expect(stored.map((finding) => finding.message.text).join()).toContain(token);
		expect(bytes(records.check("e".repeat(64), ran("static.enola", 2, "0.4.37"), stored))).not.toContain(token);
	});

	it("as the text of a static check Melian does not know yet", async () => {
		const { stored, records } = await mutation([mutant({ replacement: `"${token}"` })]);
		const madeUp: StoredFinding[] = stored.map((finding) => ({
			...finding,
			properties: { ...finding.properties, source: { check: "static.madeup", version: "1" } },
		}));
		expect(bytes(records.check("e".repeat(64), ran("static.madeup", 1, "1"), madeUp))).not.toContain(token);
	});

	it("as a Biome or tsc finding a build from before issue #281 stored with its tool's text", async () => {
		const { stored, records } = await mutation([mutant({ replacement: `"${token}"` })]);
		for (const check of ["static.biome", "static.tsc"]) {
			const old: StoredFinding[] = stored.map((finding) => ({
				...finding,
				properties: { ...finding.properties, source: { check, version: "1" } },
			}));
			expect(bytes(records.check("e".repeat(64), ran(check, 1, "1"), old))).not.toContain(token);
		}
	});

	it.each([
		["Enola's rule ID", { ruleId: `wide/${token}`, message: { text: "widget is wide" } }],
		["Enola's message", { ruleId: "god-class", message: { text: `widget holds ${token}` } }],
	])("as the dismissed sighting of a static finding, refused, with the token in %s", async (_, result) => {
		const { stored, records, revision } = await enola([{ ...result, level: "warning", locations: at(path) }]);
		const finding = stored[0]!;
		const facts: DismissalFacts = {
			finding: finding.properties.id,
			by: "maintainer",
			reason: "the class is meant to be wide",
			at: "2026-11-16T00:00:00.000Z",
			severity: finding.properties.severity,
			sighting: { revision, finding },
			rounds: [],
			trigger: { hash: "f".repeat(64), proof: [] },
		};
		expect(() => records.dismissal(facts)).toThrow(
			expect.objectContaining({ constructor: DismissError, code: "unprovenRun", finding: finding.properties.id }),
		);
	});

	it("as the dismissed sighting of an earlier build's static finding, refused beside a current check request", async () => {
		const { records, revision } = await enola([]);
		// An earlier build kept Enola's own rule and message, which the export keeps as the ID's input.
		const finding = Finding.create({
			rule: `enola/${token}`,
			message: `Enola said ${token}`,
			file: "enola-intent.yaml",
			startLine: 1,
			discriminator: `Enola said ${token}`,
			cause: "introduced",
			severity: "P2",
			explanation: { what: token, whyHere: token, whatToDo: token },
			source: { check: "static.enola", version: "0.4.37" },
		}).toJSON();
		// A caller that hands over a request the run that wrote the sighting may never have made.
		const facts = {
			finding: finding.properties.id,
			by: "maintainer",
			reason: "the layer is meant to reach",
			at: "2026-11-16T00:00:00.000Z",
			severity: finding.properties.severity,
			sighting: { revision, finding },
			rounds: [],
			trigger: { hash: "f".repeat(64), proof: [] },
			request: enolaRun,
		} as DismissalFacts;
		expect(() => records.dismissal(facts)).toThrow(
			expect.objectContaining({ constructor: DismissError, code: "unprovenRun", finding: finding.properties.id }),
		);
	});

	it("as free text in Enola's receipt", () => {
		const records = ReviewRecords.of("c".repeat(64), { base: "a".repeat(40), head: "b".repeat(40) });
		const snapshotId = `sha256:${"a".repeat(64)}`;
		const receipt = JSON.stringify({
			format_version: 1,
			snapshot_id: snapshotId,
			enola_version: "0.4.37",
			repo: `/home/reviewer/${token}`,
		});
		const record = records.check(
			"e".repeat(64),
			{ ...ran("static.enola", 0), snapshots: [{ commit: "b".repeat(40), snapshotId, receipt }] },
			[],
		);
		expect(bytes(record)).not.toContain(token);
	});
});

describe("a finding's ID holds no text a static tool wrote", () => {
	it("tells two results of one rule with no code apart, and gives each the same ID on a repeat", async () => {
		const results = [
			{ ruleId: "constraints/layer", level: "error", message: { text: `core reaches ${token}-one` } },
			{ ruleId: "constraints/layer", level: "error", message: { text: `core reaches ${token}-two` } },
		];
		const first = await enola(results);
		removeRepository(repo);
		repo = createRepository();
		const again = await enola([...results].reverse());
		const ids = first.stored.map((finding) => finding.properties.id);
		expect(new Set(ids).size).toBe(2);
		expect(again.stored.map((finding) => finding.properties.id).sort()).toEqual([...ids].sort());
		const hashed = (text: string) => `message ${createHash("sha256").update(text).digest("hex")}`;
		expect(first.stored.map((finding) => finding.properties.discriminator).sort()).toEqual(
			results.map((result) => hashed(result.message.text)).sort(),
		);
	});
});

describe("an exported record keeps what a static finding shares", () => {
	it("keeps a finding's rule, place, snippet and ID, and names its check in place of the tool's text", async () => {
		const { stored, records } = await mutation([mutant({ replacement: `"${token}"` })]);
		const payload = records.check("e".repeat(64), ran("static.mutation", 1, "10.0.0"), stored).toJSON().payload as {
			sightings: StoredFinding[];
		};
		const what = `static.mutation reports mutation/untested-behaviour here. ${withheld}.`;
		expect(payload.sightings).toEqual([
			{
				...stored[0]!,
				message: { ...stored[0]!.message, text: what },
				properties: {
					...stored[0]!.properties,
					explanation: { what, whyHere: withheld, whatToDo: withheld },
				},
			},
		]);
	});

	it("keeps a lens's finding as it is", async () => {
		const { stored, records } = await mutation([mutant({ replacement: `"${token}"` })]);
		const lens: StoredFinding[] = stored.map((finding) => ({
			...finding,
			properties: { ...finding.properties, source: { check: "lens.correctness", version: "1@careful" } },
		}));
		const run = {
			name: "correctness",
			version: "1",
			level: "careful",
			request: "d".repeat(64),
			probe: false,
		} as const;
		const payload = records.lens(run, { status: "done" }, lens).toJSON().payload as { sightings: StoredFinding[] };
		expect(payload.sightings).toEqual(lens);
	});

	it("keeps the three fields of Enola's receipt Melian checks, and withholds a receipt it cannot read", () => {
		const records = ReviewRecords.of("c".repeat(64), { base: "a".repeat(40), head: "b".repeat(40) });
		const snapshotId = `sha256:${"a".repeat(64)}`;
		const exported = (receipt: string) => {
			const result = { ...ran("static.enola", 0), snapshots: [{ commit: "b".repeat(40), snapshotId, receipt }] };
			const payload = records.check("e".repeat(64), result, []).toJSON().payload as {
				result: { snapshots: { receipt: string }[] };
			};
			return payload.result.snapshots[0]!.receipt;
		};
		const fields = { format_version: 1, snapshot_id: snapshotId, enola_version: "0.4.37" };
		expect(exported(JSON.stringify({ ...fields, repo: token }))).toBe(JSON.stringify(fields));
		expect(exported(`{${token}`)).toBe(withheld);
		expect(exported("null")).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, format_version: 2 }))).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, snapshot_id: `sha256:${token}` }))).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, snapshot_id: 7 }))).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, enola_version: token }))).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, enola_version: 4 }))).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, snapshot_id: [snapshotId] }))).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, enola_version: ["0.4.37"] }))).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, snapshot_id: `${token} ${snapshotId}` }))).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, snapshot_id: `${snapshotId} ${token}` }))).toBe(withheld);
		expect(exported(JSON.stringify({ ...fields, enola_version: `0.4.37 ${token}` }))).toBe(withheld);
		const longest = { ...fields, enola_version: `0${"1".repeat(63)}` };
		expect(exported(JSON.stringify(longest))).toBe(JSON.stringify(longest));
		expect(exported(JSON.stringify({ ...fields, enola_version: `0${"1".repeat(64)}` }))).toBe(withheld);
	});
	describe("Enola's snapshot identities, which Melian computes as hashes", () => {
		const records = ReviewRecords.of("c".repeat(64), { base: "a".repeat(40), head: "b".repeat(40) });
		const hash = "a".repeat(64);
		const receipt = JSON.stringify({ format_version: 1, snapshot_id: `sha256:${hash}`, enola_version: "0.4.37" });
		const snapshot: EnolaSnapshot = {
			commit: "b".repeat(40),
			snapshotId: `sha256:${hash}`,
			receipt,
			cacheKey: hash,
			coverage: { graph: hash, review: hash, test: hash },
		};
		const exported = (each: EnolaSnapshot) =>
			records.check("e".repeat(64), { ...ran("static.enola", 1), snapshots: [each] }, []).toJSON().payload as {
				result: { status: string; reason?: string; snapshots?: unknown };
				sightings: unknown[];
			};

		it("keeps a snapshot whose identities are hashes, and the hashes at their full length", () => {
			expect(exported(snapshot).result).toEqual(
				expect.objectContaining({ status: "ran", snapshots: [{ ...snapshot, receipt }] }),
			);
			expect(exported({ commit: snapshot.commit, snapshotId: snapshot.snapshotId, receipt }).result.status).toBe(
				"ran",
			);
		});

		it.each<[string, EnolaSnapshot]>([
			["its snapshot ID", { ...snapshot, snapshotId: `sha256:${token}` }],
			["its snapshot ID past the hash", { ...snapshot, snapshotId: `sha256:${hash} ${token}` }],
			["its snapshot ID before the hash", { ...snapshot, snapshotId: `${token} sha256:${hash}` }],
			["its cache key", { ...snapshot, cacheKey: token }],
			["its cache key past the hash", { ...snapshot, cacheKey: `${hash}${token}` }],
			["its graph coverage", { ...snapshot, coverage: { ...snapshot.coverage, graph: token } }],
			["its review coverage", { ...snapshot, coverage: { ...snapshot.coverage, review: token } }],
			["its test coverage", { ...snapshot, coverage: { ...snapshot.coverage, test: token } }],
		])("withholds the check when a snapshot holds text in %s", (_, each) => {
			const payload = exported(each);
			expect(JSON.stringify(payload)).not.toContain(token);
			expect(payload).toEqual({
				v: 1,
				result: { name: "static.enola", status: "failed", reason: "withheld", error: expect.any(String) },
				sightings: [],
			});
		});
	});
});
