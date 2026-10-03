import type { MelianConfig, Resolution, RuleAlias, Severity } from "./config.ts";
import {
	type AlsoReportedAs,
	type Finding,
	type FindingProperties,
	levelForSeverity,
	normaliseSnippet,
} from "./findings.ts";

/** The resolutions from strictest to most lenient. */
export const resolutionOrder: readonly Resolution[] = ["block", "acknowledge", "advisory", "silent"];

/** The configuration that applies at a repository-relative path, usually through `loadConfig` for that path. */
export type ConfigFor = (path: string) => Pick<MelianConfig, "resolution" | "ruleAliases">;

function lenientOf(left: Resolution, right: Resolution): Resolution {
	return resolutionOrder.indexOf(left) > resolutionOrder.indexOf(right) ? left : right;
}

/**
 * A finding adjudication has resolved. A finding without `properties.resolution` has not been adjudicated yet, which
 * says nothing about what it requires: it is neither `silent` nor anything else until {@link applyResolutions} runs.
 */
export type ResolvedFinding = Finding & {
	readonly properties: FindingProperties & { readonly resolution: Resolution };
};

/**
 * What a finding requires under `config`, the effective configuration at the finding's path: the resolution configured
 * for its severity. A finding not shown to be caused by the change, `pre-existing` or `affected` without evidence, is
 * never above `advisory`, so an old defect cannot block an unrelated change. It decides from severity, cause, and
 * evidence alone, never from a resolution the finding already carries.
 */
export function resolveFinding(finding: Finding, config: Pick<MelianConfig, "resolution">): Resolution {
	const { severity, cause, evidence } = finding.properties;
	const configured = config.resolution[severity];
	const caused = cause === "introduced" || (cause === "affected" && evidence !== undefined);
	return caused ? configured : lenientOf(configured, "advisory");
}

/**
 * Copies of `findings` with `properties.resolution` set by {@link resolveFinding}, each under the configuration
 * `configFor` returns for its path. A resolution a finding already carries is replaced, not kept.
 */
export function applyResolutions(findings: readonly Finding[], configFor: ConfigFor): ResolvedFinding[] {
	return findings.map((finding) => {
		const resolution = resolveFinding(finding, configFor(finding.properties.path));
		return { ...finding, properties: { ...finding.properties, resolution } };
	});
}

const rank: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

// Where a finding sits: its file, its normalised snippet, and which of the identical snippets in that file it is.
function siteOf(finding: Finding): string | undefined {
	const { path, occurrence } = finding.properties;
	const snippet = normaliseSnippet(finding.locations[0]!.physicalLocation.region.snippet?.text ?? "");
	return snippet === "" ? undefined : JSON.stringify([path, snippet, occurrence]);
}

function lines(finding: Finding): [number, number] {
	const { startLine, endLine = startLine } = finding.locations[0]!.physicalLocation.region;
	return [startLine, endLine];
}

function overlap(left: Finding, right: Finding): boolean {
	const [leftStart, leftEnd] = lines(left);
	const [rightStart, rightEnd] = lines(right);
	return leftStart <= rightEnd && rightStart <= leftEnd;
}

// What ranking two findings reads, so the pipeline can rank stored sightings as well as findings.
type Ranked = { readonly properties: Pick<FindingProperties, "severity" | "id" | "cause" | "evidence"> };

function strongerFirst(a: Ranked, b: Ranked): number {
	const { severity: left, id: leftId } = a.properties;
	const { severity: right, id: rightId } = b.properties;
	return rank[left] - rank[right] || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
}

function reportOf(finding: Finding): AlsoReportedAs {
	return { id: finding.properties.id, ruleId: finding.ruleId, check: finding.properties.source.check };
}

type Aliases = MelianConfig["ruleAliases"];

function entryOf(aliases: Aliases, rule: string): { rules: readonly string[]; distinct: boolean } {
	if (!Object.hasOwn(aliases, rule)) return { rules: [], distinct: false };
	const entry: RuleAlias = aliases[rule]!;
	return "rules" in entry
		? { rules: entry.rules, distinct: entry.distinct === true }
		: { rules: entry, distinct: false };
}

// Whether `ruleAliases` declares the two rules different defects, in either direction.
function distinct(aliases: Aliases, left: string, right: string): boolean {
	const declares = (owner: string, other: string) => {
		const entry = entryOf(aliases, owner);
		return entry.distinct && entry.rules.includes(other);
	};
	return declares(left, right) || declares(right, left);
}

// The finding that speaks for a defect: one whose rule `ruleAliases` names as the owner of another member's rule,
// else the most severe.
function keeperOf(defect: readonly Finding[], aliases: Aliases): Finding {
	const owners = defect.filter((finding) => {
		const entry = entryOf(aliases, finding.ruleId);
		return !entry.distinct && entry.rules.some((alias) => defect.some((other) => other.ruleId === alias));
	});
	return [...(owners.length > 0 ? owners : defect)].sort(strongerFirst)[0]!;
}

// How strongly a finding is tied to the change: introduced, then affected with evidence, then anything else.
function causeRank(finding: Ranked): number {
	const { cause, evidence } = finding.properties;
	return cause === "introduced" ? 0 : cause === "affected" && evidence !== undefined ? 1 : 2;
}

/**
 * The cause, with its evidence, that findings merged as one defect take: the strongest any of them has, in the order
 * `introduced`, `affected` with its evidence, `pre-existing`. A merge takes this rather than the cause of whichever
 * finding speaks, so merging never turns a finding that blocks into one that does not. Among the findings with the
 * strongest cause, the most severe supplies the evidence, the lower ID on a tie. Throws `RangeError` for no findings.
 */
export function strongestCause(findings: readonly Ranked[]): Pick<FindingProperties, "cause" | "evidence"> {
	const strongest = [...findings].sort((a, b) => causeRank(a) - causeRank(b) || strongerFirst(a, b))[0];
	if (strongest === undefined) throw new RangeError("strongestCause needs at least one finding");
	const rank = causeRank(strongest);
	if (rank === 0) return { cause: "introduced" };
	if (rank === 1) return { cause: "affected", evidence: strongest.properties.evidence! };
	return { cause: "pre-existing" };
}

// The speaker of a merged defect: the highest severity, and the strongest cause with its evidence, any member reported.
function speakFor(keeper: Finding, defect: readonly Finding[], alsoReportedAs: AlsoReportedAs[]): Finding {
	const severity = [...defect].sort(strongerFirst)[0]!.properties.severity;
	const { evidence: _, ...properties } = keeper.properties;
	return {
		...keeper,
		level: levelForSeverity(severity),
		properties: { ...properties, ...strongestCause(defect), severity, alsoReportedAs },
	};
}

/**
 * Merges findings that different checks reported for one defect. Two findings are one defect when different checks
 * report them in the same file, on the same normalised snippet at the same occurrence, over overlapping lines,
 * whatever their rules: two lenses that file one broken caller under `broken-caller` and `unhandled-error` describe
 * one defect. Findings from one check stay apart, since a check that reports two rules on one line means two defects,
 * and so do two rules that an entry of `ruleAliases` marks `distinct`.
 *
 * One finding speaks for each defect. `ruleAliases` in the configuration at its path decides first: a finding whose
 * rule is a key listing another member's rule is preferred, so a repository can say the defect belongs to the
 * contracts lens. Otherwise the most severe stays, the lower ID on a tie. The finding that stays takes the highest
 * severity among them and the strongest cause with its evidence ({@link strongestCause}), so a merge never lowers what
 * blocks, and lists each other's ID, rule, and check in `properties.alsoReportedAs`. A finding without a snippet is
 * never merged. Returns the findings that stay, in input order.
 */
export function dedupeFindings(
	findings: readonly Finding[],
	configFor: (path: string) => Pick<MelianConfig, "ruleAliases">,
): Finding[] {
	const defects: Finding[][] = [];
	for (const finding of [...findings].sort(strongerFirst)) {
		const site = siteOf(finding);
		const check = finding.properties.source.check;
		const aliases = configFor(finding.properties.path).ruleAliases;
		const into =
			site === undefined
				? undefined
				: defects.find(
						(defect) =>
							siteOf(defect[0]!) === site &&
							defect.every(
								(member) =>
									member.properties.source.check !== check &&
									!distinct(aliases, member.ruleId, finding.ruleId),
							) &&
							defect.some((member) => overlap(member, finding)),
					);
		if (into === undefined) defects.push([finding]);
		else into.push(finding);
	}
	const speakers = new Map<Finding, Finding>();
	for (const defect of defects) {
		if (defect.length === 1) {
			speakers.set(defect[0]!, defect[0]!);
			continue;
		}
		const keeper = keeperOf(defect, configFor(defect[0]!.properties.path).ruleAliases);
		const alsoReportedAs = [
			...(keeper.properties.alsoReportedAs ?? []),
			...defect
				.filter((member) => member !== keeper)
				.flatMap((member) => [reportOf(member), ...(member.properties.alsoReportedAs ?? [])]),
		];
		speakers.set(keeper, speakFor(keeper, defect, alsoReportedAs));
	}
	return findings.flatMap((finding) => {
		const speaker = speakers.get(finding);
		return speaker === undefined ? [] : [speaker];
	});
}

/** Whether a check ran to completion, was skipped, or failed. */
export type CheckStatus = "ran" | "skipped" | "failed";

/**
 * What one check of a review did, such as a lens, a static tool, or a guardrail. `reason` says why a check was skipped
 * or failed, for the author; `error` carries the failure's own message, for the maintainer.
 */
export interface CheckRecord {
	/** The check's name as the tiers name it, such as `lens.security` or `static.biome`. */
	readonly name: string;
	readonly status: CheckStatus;
	readonly reason?: string;
	readonly error?: string;
	/**
	 * The version of the tool that ran, as its findings name it in `properties.source.version`, such as Biome's. A review
	 * counts only that version's findings for the check; without it, every version's.
	 */
	readonly version?: string;
}

/** The reason {@link adjudicate} gives a check the manifest names that has no record. */
export const noRecord = "no record";

/**
 * A review's outcome, as a pull request's check reports it: `passed` when every check ran and nothing needs
 * attention, `findings` when every check ran and something does, and `not-reviewed` when a check failed or was skipped
 * without leave. A review that did not complete is never `passed`.
 */
export type VerdictStatus = "passed" | "findings" | "not-reviewed";

/** What a review concluded. */
export interface Verdict {
	readonly status: VerdictStatus;
	/** Whether any finding resolves to `block`, whatever the status. */
	readonly blocking: boolean;
	/** The findings that count, deduplicated and grouped by resolution, each group in path, severity, and line order. */
	readonly findings: Readonly<Record<Resolution, readonly ResolvedFinding[]>>;
	/** Findings dismissed with a reason. They neither block nor need attention. */
	readonly dismissed: readonly ResolvedFinding[];
	/**
	 * The checks that were skipped or failed, with their reasons, in input order, then each check the manifest names that
	 * left no record, as skipped with the reason {@link noRecord}.
	 */
	readonly notRun: readonly CheckRecord[];
}

/** What {@link adjudicate} decides from. */
export interface AdjudicationInput {
	/** Findings at the head under review, at most one per ID. */
	readonly findings: readonly Finding[];
	/**
	 * Every check the review's tier names, as {@link checksOfTier} expands it. Each must have a record in `checks`; one
	 * without is a check that never started, and the review is `not-reviewed`.
	 */
	readonly manifest: readonly string[];
	/** What each check did: every check of the manifest, and any other the review ran. */
	readonly checks: readonly CheckRecord[];
	/** The configuration for every path, or a function returning the configuration at a path. */
	readonly config: Pick<MelianConfig, "resolution" | "ruleAliases"> | ConfigFor;
	/** Names of checks whose skip still lets a review pass, such as a tool with no files in its language to check. */
	readonly allowSkip?: readonly string[];
}

function startLine(finding: Finding): number {
	return finding.locations[0]!.physicalLocation.region.startLine;
}

function readingOrder(a: Finding, b: Finding): number {
	const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
	return (
		order(a.properties.path, b.properties.path) ||
		rank[a.properties.severity] - rank[b.properties.severity] ||
		startLine(a) - startLine(b) ||
		order(a.properties.id, b.properties.id)
	);
}

/**
 * Decides a review: merges findings two checks reported for one problem ({@link dedupeFindings}), resolves each under
 * its path's configuration ({@link applyResolutions}), and derives the status. Every finding is resolved here, whether
 * it arrives without a resolution, as a producer stores it, or with one, which is replaced; none is dropped or counted
 * as `silent` for lacking one. A failed check, a skipped one not in `allowSkip`, or a check of the manifest with no
 * record makes the review `not-reviewed`, even with no findings. Otherwise a finding above `silent` makes it
 * `findings`, and nothing does `passed`. A dismissed finding counts toward neither.
 */
export function adjudicate({ findings, manifest, checks, config, allowSkip = [] }: AdjudicationInput): Verdict {
	const configFor = typeof config === "function" ? config : () => config;
	const resolved = applyResolutions(dedupeFindings(findings, configFor), configFor).sort(readingOrder);
	const counted = resolved.filter((finding) => finding.properties.status !== "dismissed");
	const grouped = Object.fromEntries(
		resolutionOrder.map((resolution) => [
			resolution,
			counted.filter((finding) => finding.properties.resolution === resolution),
		]),
	) as Record<Resolution, ResolvedFinding[]>;
	const recorded = new Set(checks.map((check) => check.name));
	const missing = [...new Set(manifest)].filter((name) => !recorded.has(name));
	const notRun: CheckRecord[] = [
		...checks.filter((check) => check.status !== "ran").map((check) => ({ ...check })),
		...missing.map((name) => ({ name, status: "skipped" as const, reason: noRecord })),
	];
	const incomplete =
		missing.length > 0 || notRun.some((check) => check.status === "failed" || !allowSkip.includes(check.name));
	const attention = counted.some((finding) => finding.properties.resolution !== "silent");
	return {
		status: incomplete ? "not-reviewed" : attention ? "findings" : "passed",
		blocking: grouped.block.length > 0,
		findings: grouped,
		dismissed: resolved.filter((finding) => finding.properties.status === "dismissed"),
		notRun,
	};
}
