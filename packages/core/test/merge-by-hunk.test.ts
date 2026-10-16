import { cpSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Adjudication,
	Changeset,
	defaultConfig,
	type EvidenceLocation,
	Finding,
	type Revision,
	type Severity,
	snippetOccurrence,
} from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

// Step 27, "Merge by shared cause": lens reports that one hunk caused merge, on real zero-context diffs.

type Site = [file: string, startLine: number, endLine: number, role: "cause" | "context", revision?: "head" | "base"];
type Spec = {
	check: string;
	rule: string;
	severity: Severity;
	file: string;
	lines: [number, number];
	evidence: Site[];
	trigger?: boolean;
	verdict?: "confirmed" | "refuted";
};

let repo: string;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

// Commits `base`, then `head` on a branch, and resolves the change the way a review does: zero lines of context.
async function changeOf(base: (root: string) => void, head: (root: string) => void): Promise<Revision> {
	base(repo);
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "--quiet", "-m", "base");
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	head(repo);
	gitIn(repo, "add", "-A", ".");
	gitIn(repo, "commit", "--quiet", "-m", "head");
	return (await Changeset.resolve(repo, "main...feature")).revision;
}

const textAt = (file: string, startLine: number, endLine: number, revision: "head" | "base" = "head") => {
	const content = revision === "base" ? gitIn(repo, "show", `main:${file}`) : readFileSync(join(repo, file), "utf8");
	return content
		.split("\n")
		.slice(startLine - 1, endLine)
		.join("\n");
};

// A lens finding as `report_finding` builds one: the snippet read at head, the cause and proof from the revision.
function report(revision: Revision, spec: Spec): Finding {
	const [startLine, endLine] = spec.lines;
	const snippet = textAt(spec.file, startLine, endLine);
	const evidence: EvidenceLocation[] = spec.evidence.map(([file, start, end, role, side = "head"]) => {
		const site = { file, startLine: start, endLine: end, role, revision: side };
		const proves = revision.causeOverlap(site, spec.file) !== undefined;
		return { ...site, ...(proves ? { proves } : {}), snippet: textAt(file, start, end, side) };
	});
	const cause = revision.classifyCause({ file: spec.file, startLine, endLine }, evidence);
	const trigger =
		cause === "introduced" && spec.trigger !== false ? revision.trigger(spec.file, startLine, endLine) : undefined;
	return Finding.create({
		rule: spec.rule,
		message: `${spec.rule} reported by ${spec.check}`,
		file: spec.file,
		startLine,
		endLine,
		snippet,
		occurrence: snippetOccurrence(readFileSync(join(repo, spec.file), "utf8"), snippet, { startLine, endLine }),
		cause,
		...(spec.check.startsWith("lens.")
			? { failureScenario: `${spec.check}: republishCommand(policy, "mallory") returns "republished".`, evidence }
			: {}),
		...(trigger === undefined ? {} : { trigger }),
		severity: spec.severity,
		...(spec.verdict === undefined
			? {}
			: {
					verification: {
						verdict: spec.verdict,
						reason: `The verifier read ${spec.rule}.`,
						executor: "llm" as const,
						model: "openai-codex/gpt-5.6-terra",
						version: "1",
					},
				}),
		explanation: { what: spec.rule, whyHere: "The change.", whatToDo: "Fix it." },
		source: { check: spec.check, version: "1" },
	});
}

// The members of each defect, as sorted ID lists, sorted.
const groups = (revision: Revision | undefined, findings: readonly Finding[]) => {
	const input = { findings, manifest: [], checks: [], config: defaultConfig, revision };
	return new Adjudication(input)
		.defects()
		.map((defect) => [defect.speaker.properties.id, ...defect.members.map((member) => member.id)].sort())
		.sort();
};

const permutations = <T>(items: readonly T[]): T[][] =>
	items.length <= 1
		? [[...items]]
		: items.flatMap((item, index) =>
				permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
			);

describe("the design golden that supersedes its own decision", () => {
	const golden = fileURLToPath(new URL("../../evals/goldens/design-supersedes-its-own-decision/", import.meta.url));
	const copy = (side: "base" | "head") => (root: string) => {
		for (const entry of ["docs", "src"]) rmSync(join(root, entry), { recursive: true, force: true });
		cpSync(join(golden, side), root, { recursive: true });
	};
	let revision: Revision;
	beforeEach(async () => {
		revision = await changeOf(copy("base"), copy("head"));
	});

	// As step0-attribution.out recorded the Opus finders' reports at bb8c0100's parent.
	const design: Spec = {
		check: "lens.design",
		rule: "fail-open-default",
		severity: "P0",
		file: "src/publish.ts",
		lines: [6, 7],
		evidence: [
			["src/publish.ts", 5, 7, "cause"],
			["src/cli.ts", 8, 8, "cause"],
			["src/publish.ts", 3, 3, "cause"],
		],
	};
	const trustBoundary: Spec = {
		check: "lens.trust-boundary",
		rule: "fail-open",
		severity: "P1",
		file: "src/publish.ts",
		lines: [5, 7],
		evidence: [
			["src/publish.ts", 5, 7, "cause"],
			["src/cli.ts", 7, 9, "cause"],
		],
	};
	const droppedGuard: Spec = {
		check: "lens.removed-behaviour",
		rule: "dropped-guard",
		severity: "P1",
		file: "src/publish.ts",
		lines: [3, 8],
		evidence: [
			["src/publish.ts", 3, 6, "cause", "base"],
			["src/publish.ts", 3, 8, "context"],
			["src/cli.ts", 7, 9, "context"],
		],
	};
	const caller: Spec = {
		check: "lens.correctness",
		rule: "wrong-result",
		severity: "P1",
		file: "src/cli.ts",
		lines: [8, 8],
		evidence: [
			["src/cli.ts", 8, 8, "cause"],
			["src/publish.ts", 5, 7, "cause"],
		],
	};

	it("splits src/publish.ts into two hunks, as Melian diffs it", () => {
		const publish = revision.files.find((file) => file.path === "src/publish.ts")!;
		expect(
			publish.hunks.map(({ oldStart, oldLines, newStart, newLines }) => [oldStart, oldLines, newStart, newLines]),
		).toEqual([
			[3, 1, 3, 1],
			[5, 2, 5, 3],
		]);
	});

	it("merges three lenses' reports of the fail-open default, and keeps the caller in cli.ts apart", () => {
		const [a, b, c, d] = [design, trustBoundary, droppedGuard, caller].map((spec) => report(revision, spec));
		expect([a, b, c].map((each) => each.properties.cause)).toEqual(["introduced", "introduced", "introduced"]);
		expect(new Set([a, b, c].map((each) => each.site())).size).toBe(3);
		const expected = [[a, b, c].map((each) => each!.properties.id).sort(), [d!.properties.id]].sort();
		for (const order of permutations([a!, b!, c!, d!])) expect(groups(revision, order)).toEqual(expected);
	});

	it("speaks through the P0, which lists the other two", () => {
		const findings = [design, trustBoundary, droppedGuard].map((spec) => report(revision, spec));
		const [defect, ...rest] = new Adjudication({
			findings,
			manifest: [],
			checks: [],
			config: defaultConfig,
			...{ revision },
		}).defects();
		expect(rest).toEqual([]);
		expect(defect!.speaker.properties).toMatchObject({ id: findings[0]!.properties.id, severity: "P0" });
		expect(defect!.members.map((member) => member.id).sort()).toEqual(
			[findings[1]!.properties.id, findings[2]!.properties.id].sort(),
		);
	});

	it("merges by snippet only when the input holds no hunks, as a stored input from before the step does", () => {
		const findings = [design, trustBoundary, droppedGuard].map((spec) => report(revision, spec));
		expect(groups(undefined, findings)).toHaveLength(3);
	});

	// Three reports on hunk 1, where A and B share line 5 and B and C share line 6, but A and C share nothing.
	it("never chains, and groups alike whatever the order or the severities", () => {
		const at = (check: string, rule: string, lines: [number, number], severity: Severity) =>
			report(revision, {
				check,
				rule,
				severity,
				file: "src/publish.ts",
				lines,
				evidence: [["src/publish.ts", lines[0], lines[1], "cause"]],
			});
		const variants = (["P1", "P2"] as const).flatMap((first) =>
			(["P1", "P2"] as const).map((last) => [
				at("lens.design", "fail-open-default", [3, 5], first),
				at("lens.trust-boundary", "fail-open", [5, 6], "P2"),
				at("lens.correctness", "wrong-result", [6, 7], last),
			]),
		);
		const [first] = variants;
		const expected = groups(revision, first!);
		expect(expected).toHaveLength(2);
		const [a, , c] = first!.map((each) => each.properties.id);
		expect(expected.some((group) => group.includes(a!) && group.includes(c!))).toBe(false);
		for (const findings of variants) {
			for (const order of permutations(findings)) expect(groups(revision, order)).toEqual(expected);
		}
	});

	it("keeps a deterministic report on the hunk apart from the lens defect", () => {
		const lens = report(revision, design);
		const mutant = report(revision, {
			check: "static.mutation",
			rule: "untested-behaviour",
			severity: "P2",
			file: "src/publish.ts",
			lines: [6, 6],
			evidence: [],
		});
		expect(mutant.properties.trigger).toBeDefined();
		expect(groups(revision, [lens, mutant])).toHaveLength(2);
	});

	it("keeps apart two reports from one lens, and two rules an alias marks distinct", () => {
		const [a, b] = [design, { ...trustBoundary, check: "lens.design" }].map((spec) => report(revision, spec));
		expect(groups(revision, [a!, b!])).toHaveLength(2);
		const [c, d] = [design, trustBoundary].map((spec) => report(revision, spec));
		const apart = {
			...defaultConfig,
			ruleAliases: { "fail-open-default": { rules: ["fail-open"], distinct: true } },
		};
		const input = { findings: [c!, d!], manifest: [], checks: [], config: apart, revision };
		expect(new Adjudication(input).defects()).toHaveLength(2);
	});

	it("keeps apart two reports whose shared lines fall on no hunk", () => {
		// Lines 7-8 share line 8, the unchanged closing brace.
		const [a, b] = [
			{ ...design, lines: [7, 8] as [number, number] },
			{ ...trustBoundary, lines: [8, 8] as [number, number], evidence: [["src/publish.ts", 5, 7, "cause"] as Site] },
		].map((spec) => report(revision, spec));
		expect(groups(revision, [a!, b!])).toHaveLength(2);
	});

	it("keeps apart two reports whose lines overlap the same hunk but not each other", () => {
		const [a, b] = [
			{ ...design, lines: [5, 5] as [number, number] },
			{ ...trustBoundary, lines: [7, 7] as [number, number] },
		].map((spec) => report(revision, spec));
		expect(groups(revision, [a!, b!])).toHaveLength(2);
	});

	// One line-range report on hunk 1 of src/publish.ts, from `check`.
	const on = (check: string, range: [number, number], extra: Partial<Spec> = {}) =>
		report(revision, {
			check,
			rule: `${check.slice(5)}-rule`,
			severity: "P1",
			file: "src/publish.ts",
			lines: range,
			evidence: [["src/publish.ts", range[0], range[1], "cause"]],
			...extra,
		});

	// The second attack's F1: A and S share a snippet, and B meets A through the hunk alone.
	it("keeps a lens report with its deterministic co-report, whatever the order", () => {
		const a = on("lens.correctness", [6, 6]);
		const s = report(revision, {
			check: "static.mutation",
			rule: "untested-behaviour",
			severity: "P2",
			file: "src/publish.ts",
			lines: [6, 6],
			evidence: [],
		});
		const b = on("lens.trust-boundary", [5, 7]);
		const expected = [[a.properties.id, s.properties.id].sort(), [b.properties.id]].sort();
		for (const order of permutations([a, s, b])) {
			expect(groups(revision, order)).toEqual(expected);
			const input = { findings: order, manifest: [], checks: [], config: defaultConfig, revision };
			const holding = new Adjudication(input)
				.defects()
				.find((defect) => [defect.speaker.id, ...defect.members.map((member) => member.id)].includes(a.id))!;
			expect(holding.lensOnly()).toBe(false);
		}
	});

	// The second attack's F2, case 1: only w-x, x-y and y-z meet.
	it("makes the fewest groups, by end line", () => {
		const w = on("lens.design", [5, 5]);
		const x = on("lens.trust-boundary", [5, 6]);
		const y = on("lens.correctness", [6, 7]);
		const z = on("lens.contracts", [7, 7]);
		const expected = [[w.properties.id, x.properties.id].sort(), [y.properties.id, z.properties.id].sort()].sort();
		for (const order of permutations([w, x, y, z])) expect(groups(revision, order)).toEqual(expected);
	});

	// The second attack's F2, case 2: a push adds one report, and the reports it does not meet keep their group.
	it("leaves untouched reports grouped as they were when a push adds a report", () => {
		const a1 = on("lens.design", [5, 5]);
		const a2 = on("lens.trust-boundary", [5, 6], { severity: "P0" });
		const a3 = on("lens.correctness", [6, 7]);
		const before = [[a1.properties.id, a2.properties.id].sort(), [a3.properties.id]].sort();
		expect(groups(revision, [a1, a2, a3])).toEqual(before);
		const a0 = on("lens.contracts", [6, 6]);
		expect(groups(revision, [a1, a2, a3, a0])).toEqual(
			[[a1.properties.id, a2.properties.id].sort(), [a0.properties.id, a3.properties.id].sort()].sort(),
		);
		const elsewhere = on("lens.removed-behaviour", [3, 3]);
		expect(groups(revision, [a1, a2, a3, elsewhere])).toEqual([...before, [elsewhere.properties.id]].sort());
	});

	// The second attack's F3: a refuted P1 and a confirmed P2 of one defect.
	it.each([
		["by hunk", [5, 7], [6, 7]],
		["by snippet", [5, 7], [5, 7]],
	] as const)("never speaks through a refuted report while another stands, merged %s", (_, first, second) => {
		const refuted = on("lens.trust-boundary", [...first], { rule: "sql-injection", verdict: "refuted" });
		const standing = on("lens.tests", [...second], {
			rule: "untested-behaviour",
			severity: "P2",
			verdict: "confirmed",
		});
		for (const order of permutations([refuted, standing])) {
			const input = { findings: order, manifest: [], checks: [], config: defaultConfig, revision };
			const [defect, ...rest] = new Adjudication(input).defects();
			expect(rest).toEqual([]);
			expect(defect!.speaker.properties).toMatchObject({ id: standing.properties.id, severity: "P2" });
			expect(defect!.members.map((member) => member.id)).toEqual([refuted.properties.id]);
		}
	});

	// The second attack's F4: a member's ID dismisses that report alone; the speaker's, the whole defect.
	it("dismisses a member alone by its ID, and the whole defect by the speaker's", () => {
		const findings = [design, trustBoundary, droppedGuard].map((spec) => report(revision, spec));
		const input = { findings, manifest: [], checks: [], config: defaultConfig, revision };
		const [defect] = new Adjudication(input).defects();
		const [speaker, member, other] = findings.map((each) => each.properties.id);
		expect(defect!.dismiss(member!)).toEqual([member]);
		expect(defect!.dismiss(speaker!).sort()).toEqual([speaker, member, other].sort());
		expect(defect!.dismiss(speaker!, true)).toEqual([speaker]);
	});
});

// A callee changes and its unchanged caller breaks. Two lenses report the caller on overlapping lines, citing the
// callee's change as the cause, so both are affected and only their proof ties them to the change.
describe("an unchanged caller that two lenses report", () => {
	const caller = lines(
		'import { limit } from "./limit.ts";',
		"",
		"export function page(rows: string[], size: number): string[] {",
		"\tconst count = limit(size);",
		"\treturn rows.slice(0, count);",
		"}",
	);
	const at = (check: string, rule: string, range: [number, number], cause: Site): Spec => ({
		check,
		rule,
		severity: "P1",
		file: "src/page.ts",
		lines: range,
		evidence: [cause, ["src/page.ts", range[0], range[1], "context"]],
	});

	it("merges the two when one changed line of the callee proves both", async () => {
		const revision = await changeOf(
			(root) =>
				writeFiles(root, {
					"src/page.ts": caller,
					"src/limit.ts": lines(
						"export function limit(size: number): number {",
						"\treturn Math.max(size, 1);",
						"}",
					),
				}),
			(root) =>
				writeFiles(root, {
					"src/limit.ts": lines(
						"export function limit(size: number): number {",
						"\treturn Math.min(size, 0);",
						"}",
					),
				}),
		);
		const [a, b] = [
			at("lens.correctness", "wrong-result", [4, 5], ["src/limit.ts", 2, 2, "cause"]),
			at("lens.contracts", "broken-caller", [5, 5], ["src/limit.ts", 1, 2, "cause"]),
		].map((spec) => report(revision, spec));
		expect([a!.properties.cause, b!.properties.cause]).toEqual(["affected", "affected"]);
		expect(groups(revision, [a!, b!])).toHaveLength(1);
	});

	it("merges the two when a deletion-only hunk removed the guard they both cite at the base", async () => {
		const revision = await changeOf(
			(root) =>
				writeFiles(root, {
					"src/page.ts": caller,
					"src/limit.ts": lines(
						"export function limit(size: number): number {",
						'\tif (size < 1) throw new RangeError("size must be positive");',
						"\treturn size;",
						"}",
					),
				}),
			(root) =>
				writeFiles(root, {
					"src/limit.ts": lines("export function limit(size: number): number {", "\treturn size;", "}"),
				}),
		);
		const limit = revision.files.find((file) => file.path === "src/limit.ts")!;
		expect(limit.hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newLines])).toEqual([[2, 1, 0]]);
		const [a, b] = [
			at("lens.removed-behaviour", "dropped-guard", [4, 5], ["src/limit.ts", 2, 2, "cause", "base"]),
			at("lens.correctness", "wrong-result", [5, 5], ["src/limit.ts", 1, 3, "cause", "base"]),
		].map((spec) => report(revision, spec));
		expect([a!.properties.cause, b!.properties.cause]).toEqual(["affected", "affected"]);
		expect(groups(revision, [a!, b!])).toHaveLength(1);
	});

	it("keeps the two apart when different hunks prove them", async () => {
		const revision = await changeOf(
			(root) =>
				writeFiles(root, {
					"src/page.ts": caller,
					"src/limit.ts": lines(
						"export function limit(size: number): number {",
						"\treturn Math.max(size, 1);",
						"}",
						"",
						"export const floor = 1;",
					),
				}),
			(root) =>
				writeFiles(root, {
					"src/limit.ts": lines(
						"export function limit(size: number): number {",
						"\treturn Math.min(size, 0);",
						"}",
						"",
						"export const floor = 0;",
					),
				}),
		);
		const [a, b] = [
			at("lens.correctness", "wrong-result", [4, 5], ["src/limit.ts", 2, 2, "cause"]),
			at("lens.contracts", "broken-caller", [5, 5], ["src/limit.ts", 5, 5, "cause"]),
		].map((spec) => report(revision, spec));
		expect([a!.properties.cause, b!.properties.cause]).toEqual(["affected", "affected"]);
		expect(groups(revision, [a!, b!])).toHaveLength(2);
	});
});
