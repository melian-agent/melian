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

const reportOf = (finding: Finding) => {
	const { id, source, severity } = finding.properties;
	return { id, ruleId: finding.ruleId, check: source.check, severity };
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

	it("names a dismissed report beside a hunk group only when it shares a part's snippet or meets every report", () => {
		const [a, b] = [design, trustBoundary].map((spec) => report(revision, spec));
		const dismissedAt = (check: string, range: [number, number]) => {
			const each = on(check, range);
			return Finding.from({ ...each.toJSON(), properties: { ...each.properties, status: "dismissed" } });
		};
		const listed = (gone: Finding, hunks = true) => {
			const at = hunks ? revision : undefined;
			const input = { findings: [a!, b!, gone], manifest: [], checks: [], config: defaultConfig, revision: at };
			const live = new Adjudication(input).dedupe().find((each) => each.properties.status !== "dismissed")!;
			return (live.properties.alsoReportedAs ?? []).some((other) => other.id === gone.properties.id);
		};
		// The trust-boundary lens reported b, so this one meets b by nothing, but it shares the design report's snippet.
		expect(listed(dismissedAt("lens.trust-boundary", [6, 7]))).toBe(true);
		// Line 5 meets b through the hunk, but not the design report at lines 6-7.
		expect(listed(dismissedAt("lens.correctness", [5, 5]))).toBe(false);
		// Without the revision there is no hunk to meet through.
		expect(listed(dismissedAt("lens.correctness", [5, 6]), false)).toBe(false);
	});

	it("keeps a deterministic report on the hunk apart from the lens defect", () => {
		const lens = report(revision, design);
		// At line 6 the mutant's group comes before the lens report's, at line 7 after it.
		for (const line of [6, 7]) {
			const mutant = report(revision, {
				check: "static.mutation",
				rule: "untested-behaviour",
				severity: "P2",
				file: "src/publish.ts",
				lines: [line, line],
				evidence: [],
			});
			expect(mutant.properties.trigger).toBeDefined();
			expect(groups(revision, [lens, mutant])).toHaveLength(2);
		}
	});

	// Two reports from one lens on the same lines never meet, so the order between their groups decides which joins.
	it("breaks a tie between groups on the same lines by their lowest ID, whatever the input order or severity", () => {
		const opener = on("lens.correctness", [5, 7]);
		// Merged by snippet; its strongest report, the P0, has the higher ID, and `second` sorts between the two.
		const strongest = on("lens.design", [6, 7], { severity: "P0" });
		const lowest = on("lens.trust-boundary", [6, 7], { rule: "trust-27", severity: "P2" });
		const second = on("lens.design", [6, 7], { rule: "second-1" });
		// The weakest of the snippet group comes last in it, with an ID above `second`'s.
		const weakest = on("lens.contracts", [6, 7], { rule: "last-1", severity: "P3" });
		expect(lowest.properties.id < second.properties.id && second.properties.id < strongest.properties.id).toBe(true);
		expect(weakest.properties.id > second.properties.id).toBe(true);
		const expected = [
			[opener, strongest, lowest, weakest].map((each) => each.properties.id).sort(),
			[second.properties.id],
		].sort();
		for (const order of permutations([opener, strongest, lowest, weakest, second])) {
			expect(groups(revision, order)).toEqual(expected);
		}
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

	it("keeps apart two introduced reports whose shared lines fall on no hunk", () => {
		// Lines 3-4 and 4-5 share line 4, the unchanged blank line between hunk 0 and hunk 1.
		const [a, b] = [
			{ ...design, lines: [3, 4] as [number, number] },
			{ ...trustBoundary, lines: [4, 5] as [number, number] },
		].map((spec) => report(revision, spec));
		expect([a!.properties.cause, b!.properties.cause]).toEqual(["introduced", "introduced"]);
		expect(groups(revision, [a!, b!])).toHaveLength(2);
	});

	it("merges an introduced report with an affected one that the same hunk proves, on a shared unchanged line", () => {
		// Line 8, the closing brace, is unchanged; the trust-boundary report there cites hunk 1 as its cause.
		const [a, b] = [
			{ ...design, lines: [7, 8] as [number, number] },
			{ ...trustBoundary, lines: [8, 8] as [number, number], evidence: [["src/publish.ts", 5, 7, "cause"] as Site] },
		].map((spec) => report(revision, spec));
		expect([a!.properties.cause, b!.properties.cause]).toEqual(["introduced", "affected"]);
		expect(groups(revision, [a!, b!])).toHaveLength(1);
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

	// Start order would put a, then b, together, and leave c alone; end order lets c, which ends first, join a.
	it("takes groups by end line before start line", () => {
		const a = on("lens.design", [5, 6], { rule: "first-3" });
		const b = on("lens.trust-boundary", [5, 7]);
		const c = on("lens.trust-boundary", [6, 6], { rule: "another-rule" });
		expect(a.properties.id < b.properties.id).toBe(true);
		const expected = [[a.properties.id, c.properties.id].sort(), [b.properties.id]].sort();
		for (const order of permutations([a, b, c])) expect(groups(revision, order)).toEqual(expected);
	});

	it("orders two tied groups by ID, not by strength", () => {
		const opener = on("lens.correctness", [5, 7]);
		// One lens, so the two never meet; the weaker has the lower ID, and it joins the opener.
		const weaker = on("lens.design", [6, 7], { rule: "trust-27", severity: "P2" });
		const stronger = on("lens.design", [6, 7], { rule: "second-1", severity: "P0" });
		expect(weaker.properties.id < stronger.properties.id).toBe(true);
		const expected = [[opener.properties.id, weaker.properties.id].sort(), [stronger.properties.id]].sort();
		for (const order of permutations([opener, weaker, stronger])) expect(groups(revision, order)).toEqual(expected);
	});

	it("joins a snippet group to a hunk group only when every report of it meets every report there", () => {
		const opener = on("lens.design", [5, 7]);
		// The design report of the pair shares the opener's lens, so it never meets it; the tests report would.
		const [same, other] = [on("lens.design", [6, 7], { rule: "pair-rule" }), on("lens.tests", [6, 7])];
		const expected = [[opener.properties.id], [same.properties.id, other.properties.id].sort()].sort();
		for (const order of permutations([opener, same, other])) expect(groups(revision, order)).toEqual(expected);
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
			expect(defect!.speaker.properties.originalSeverity).toBeUndefined();
			expect(defect!.members.map((member) => member.id)).toEqual([refuted.properties.id]);
		}
	});

	// The review of record's F4: a hunk member dismissed by its own ID stays in the speaker's listing.
	it("keeps a dismissed report apart from a live one the same hunk caused, and lists it as dismissed", () => {
		const live = report(revision, design);
		const dismissed = Finding.from({
			...report(revision, trustBoundary).toJSON(),
			properties: { ...report(revision, trustBoundary).properties, status: "dismissed" },
		});
		expect(groups(revision, [live, dismissed])).toHaveLength(2);
		const input = { findings: [live, dismissed], manifest: [], checks: [], config: defaultConfig, revision };
		const speaker = new Adjudication(input).dedupe().find((each) => each.properties.status !== "dismissed")!;
		expect(speaker.properties.alsoReportedAs).toEqual([{ ...reportOf(dismissed), dismissed: true }]);
	});

	// Codex's H2 on pull request 131: a finding one lens also sighted never merges with that lens's other report.
	it("keeps apart reports whose sets of reporting checks share one, in either pass, whichever source won", () => {
		const b = on("lens.tests", [5, 7]);
		const sightedBy = (check: string, range: [number, number]) => {
			const a = on(check, range, { rule: "shared-rule" });
			return Finding.from({
				...a.toJSON(),
				properties: {
					...a.properties,
					reportedBy: [
						{ check: "lens.design", version: "1" },
						{ check: "lens.tests", version: "1" },
					],
				},
			});
		};
		// Before a lowering, design's sighting wins; after, the tests sighting does.
		for (const check of ["lens.design", "lens.tests"]) {
			expect(groups(revision, [sightedBy(check, [6, 7]), b])).toHaveLength(2);
			expect(groups(revision, [sightedBy(check, [5, 7]), b])).toHaveLength(2);
		}
		expect(groups(revision, [on("lens.design", [6, 7], { rule: "shared-rule" }), b])).toHaveLength(1);
	});

	// Two reports from one lens tie on the severity the lens reported; the lower ID joins the other lens's report.
	it("breaks a tie in the snippet pass by ID, whatever the input order", () => {
		const b = on("lens.trust-boundary", [6, 6]);
		const [c1, c2] = [
			on("lens.design", [6, 6], { rule: "rule-one" }),
			on("lens.design", [6, 6], { rule: "rule-two" }),
		];
		const [low, high] = [c1, c2].sort((x, y) => x.properties.id.localeCompare(y.properties.id));
		const expected = [[low!.properties.id, b.properties.id].sort(), [high!.properties.id]].sort();
		for (const order of permutations([b, c1, c2])) expect(groups(undefined, order)).toEqual(expected);
	});

	// The review of record's F2: one lens with two rules on one snippet, and a lowering of the first.
	it("groups the snippet pass by the severity the lens reported, so a lowering never regroups it", () => {
		const a = on("lens.design", [6, 6], { rule: "rule-a" });
		const b = on("lens.trust-boundary", [6, 6], { severity: "P2" });
		const lowered = Finding.from({
			...a.toJSON(),
			level: "warning",
			properties: { ...a.properties, severity: "P2", originalSeverity: "P1" },
		});
		for (let index = 0; index < 6; index++) {
			const c = on("lens.design", [6, 6], { rule: `rule-c${index}`, severity: "P2" });
			const before = groups(revision, [a, b, c]);
			expect(before).toEqual([[a.properties.id, b.properties.id].sort(), [c.properties.id]].sort());
			expect(groups(revision, [lowered, b, c])).toEqual(before);
		}
	});

	it("names a dismissed report beside a hunk group, through any snippet group it holds", () => {
		const [a, b] = [design, trustBoundary].map((spec) => report(revision, spec));
		// Same lines as the design report, so it shares its snippet; the trust-boundary group opens the hunk group.
		const gone = Finding.from({
			...on("lens.correctness", [6, 7]).toJSON(),
			properties: { ...on("lens.correctness", [6, 7]).properties, status: "dismissed" },
		});
		const input = { findings: [a!, b!, gone], manifest: [], checks: [], config: defaultConfig, revision };
		const [speaker] = new Adjudication(input).dedupe();
		expect(speaker!.properties.alsoReportedAs).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: gone.properties.id, dismissed: true })]),
		);
	});

	it("keeps apart a finding that a deterministic check also sighted", () => {
		const lens = report(revision, design);
		const sighted = on("lens.trust-boundary", [5, 7]);
		const shared = Finding.from({
			...sighted.toJSON(),
			properties: { ...sighted.properties, reportedBy: [sighted.properties.source, { check: "static.biome" }] },
		});
		expect(groups(revision, [lens, sighted])).toHaveLength(1);
		expect(groups(revision, [lens, shared])).toHaveLength(2);
	});

	it("speaks through the most severe of a wholly refuted defect", () => {
		const first = on("lens.trust-boundary", [5, 7], { verdict: "refuted" });
		const second = on("lens.tests", [6, 7], { severity: "P2", verdict: "refuted" });
		const input = { findings: [second, first], manifest: [], checks: [], config: defaultConfig, revision };
		const [defect, ...rest] = new Adjudication(input).defects();
		expect(rest).toEqual([]);
		expect(defect!.speaker.properties).toMatchObject({ id: first.properties.id, severity: "P1" });
	});

	it("outlines the files the findings name, by their own path and their evidence's", () => {
		const callerReport = report(revision, caller);
		expect(revision.outline([callerReport]).map((file) => file.path)).toEqual(["src/cli.ts", "src/publish.ts"]);
		const bare = report(revision, { ...caller, evidence: [["src/cli.ts", 8, 8, "cause"]] });
		const outline = revision.outline([bare]);
		expect(outline.map((file) => file.path)).toEqual(["src/cli.ts"]);
		expect(outline[0]!.hunks.every((hunk) => hunk.text === "" && hunk.header === "")).toBe(true);
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
		// The review of record's F1: reports that joined only through a hunk stay live.
		expect(defect!.dismiss(speaker!, false, new Set([other!])).sort()).toEqual([speaker, member].sort());
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

	it("keeps apart two callers in different files on the same line numbers, though one hunk proves both", async () => {
		const revision = await changeOf(
			(root) =>
				writeFiles(root, {
					"src/page.ts": caller,
					"src/list.ts": caller,
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
			{ ...at("lens.contracts", "broken-caller", [5, 5], ["src/limit.ts", 2, 2, "cause"]), file: "src/list.ts" },
		].map((spec) => report(revision, { ...spec, evidence: spec.evidence.slice(0, 1) }));
		expect([a!.properties.cause, b!.properties.cause]).toEqual(["affected", "affected"]);
		expect(groups(revision, [a!, b!])).toHaveLength(2);
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
			{
				...at("lens.contracts", "broken-caller", [5, 5], ["src/limit.ts", 5, 5, "cause"]),
				// Context on the other report's hunk proves nothing.
				evidence: [
					["src/limit.ts", 5, 5, "cause"],
					["src/limit.ts", 2, 2, "context"],
				] as Site[],
			},
		].map((spec) => report(revision, spec));
		expect([a!.properties.cause, b!.properties.cause]).toEqual(["affected", "affected"]);
		expect(groups(revision, [a!, b!])).toHaveLength(2);

		// A sighting of the first report's ID by another lens cites the second hunk: every claim counts.
		const [claim] = b!.claims();
		const sighted = Finding.from({
			...a!.toJSON(),
			properties: {
				...a!.properties,
				reportedBy: [a!.properties.source, { check: "lens.security", version: "1" }],
				otherClaims: [
					{ ...claim!, id: a!.properties.id, ruleId: a!.ruleId, source: { check: "lens.security", version: "1" } },
				],
			},
		});
		expect(groups(revision, [sighted, b!])).toHaveLength(1);
	});

	it("keeps apart two reports that only a rename without an edit proves, which names no hunk", async () => {
		const config = lines("export const port = 8080;");
		const server = lines('import { port } from "./config.ts";', "", 'export const url = "http://localhost:" + port;');
		const revision = await changeOf(
			(root) => writeFiles(root, { "src/config.ts": config, "src/server.ts": server }),
			(root) => {
				rmSync(join(root, "src/config.ts"));
				writeFiles(root, { "src/settings.ts": config });
			},
		);
		expect(revision.files.find((file) => file.path === "src/settings.ts")).toMatchObject({
			oldPath: "src/config.ts",
		});
		const [a, b] = [
			{
				...at("lens.contracts", "broken-import", [1, 1], ["src/config.ts", 1, 1, "cause", "base"]),
				file: "src/server.ts",
			},
			{
				...at("lens.correctness", "wrong-result", [1, 3], ["src/config.ts", 1, 1, "cause", "base"]),
				file: "src/server.ts",
			},
		].map((spec) => report(revision, { ...spec, evidence: spec.evidence.slice(0, 1) }));
		expect([a!.properties.cause, b!.properties.cause]).toEqual(["affected", "affected"]);
		expect(groups(revision, [a!, b!])).toHaveLength(2);
		expect(revision.outline([a!]).map((file) => file.path)).toEqual(["src/settings.ts"]);
	});
});
