import type { MelianConfig, Resolution, RuleAlias, Severity } from "./config.ts";
import {
	type AlsoReportedAs,
	type EvidenceLocation,
	type Finding,
	type FindingEvidence,
	type FindingProperties,
	levelForSeverity,
	type MemberClaim,
	maxEvidenceLocations,
	normaliseSnippet,
	wasCut,
} from "./findings.ts";
import type { ScrutinyLevel } from "./lens.ts";

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
 * for its severity. A finding not shown to be caused by the change, `pre-existing` or `affected` without a `cause`
 * evidence location marked `proves`, is never above `advisory`, so an old defect cannot block an unrelated change. A
 * finding stored before Melian marked proving locations marks none, and any `cause` location of it counts. It decides
 * from severity, cause, and evidence alone, never from a resolution the finding already carries.
 */
export function resolveFinding(finding: Finding, config: Pick<MelianConfig, "resolution">): Resolution {
	const configured = config.resolution[finding.properties.severity];
	return causeRank(finding) < 2 ? configured : lenientOf(configured, "advisory");
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

// Where a finding sits: its file, its normalised snippet, and which of the identical snippets in that file it is. Two
// cut snippets alike may differ past the cut, so a cut one sits on its lines too.
function siteOf(finding: Finding): string | undefined {
	const { path, occurrence } = finding.properties;
	const { snippet: stored, startLine, endLine = startLine } = finding.locations[0]!.physicalLocation.region;
	const snippet = normaliseSnippet(stored?.text ?? "");
	if (snippet === "") return undefined;
	return JSON.stringify([path, snippet, occurrence, ...(wasCut(stored!.text) ? [startLine, endLine] : [])]);
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
type Ranked = {
	readonly properties: Pick<FindingProperties, "severity" | "id" | "cause" | "evidence">;
};

function strongerFirst(a: Ranked, b: Ranked): number {
	const { severity: left, id: leftId } = a.properties;
	const { severity: right, id: rightId } = b.properties;
	return rank[left] - rank[right] || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
}

function reportOf(finding: Finding): AlsoReportedAs {
	const { id, source, severity, dismissal } = finding.properties;
	return {
		id,
		ruleId: finding.ruleId,
		check: source.check,
		severity,
		...(dismissal === undefined ? {} : { dismissal: { ...dismissal } }),
	};
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

// How strongly a finding is tied to the change: introduced, then affected with a proving cause location, then anything
// else.
function causeRank(finding: Ranked): number {
	const { cause, evidence = [] } = finding.properties;
	if (cause === "introduced") return 0;
	if (cause !== "affected") return 2;
	// A finding stored before `proves` existed marks no location; any `cause` location counts, so it resolves as it did.
	const marked = evidence.some((location) => location.proves === true);
	return evidence.some((location) => location.role === "cause" && (location.proves === true || !marked)) ? 1 : 2;
}

/** A finding or a stored sighting, as {@link mergeClaims} reads it. */
export type Claimant = {
	readonly ruleId: string;
	readonly properties: Pick<
		FindingProperties,
		"severity" | "id" | "cause" | "evidence" | "failureScenario" | "source" | "otherClaims"
	>;
};

function sameLocation(left: EvidenceLocation, right: EvidenceLocation): boolean {
	return (
		left.file === right.file &&
		left.startLine === right.startLine &&
		(left.endLine ?? left.startLine) === (right.endLine ?? right.startLine) &&
		left.role === right.role &&
		left.revision === right.revision
	);
}

// The speaker's evidence with the prover's `cause` locations it lacks, ten in all, those marked `proves` first. At
// least one of those stays, taking the speaker's last place if the speaker cites ten, so the merged cause never lacks
// its proof.
function withProof(own: FindingEvidence | undefined, proof: readonly EvidenceLocation[]): FindingEvidence | undefined {
	const cited = own ?? [];
	const missing = proof
		.filter((location) => !cited.some((each) => sameLocation(each, location)))
		.sort((left, right) => Number(right.proves === true) - Number(left.proves === true));
	if (missing.length === 0) return own;
	const imported = missing.slice(0, Math.max(maxEvidenceLocations - cited.length, 1));
	return [...cited.slice(0, maxEvidenceLocations - imported.length), ...imported];
}

function claimOf({ ruleId, properties }: Claimant): MemberClaim[] {
	const { id, source, failureScenario, evidence } = properties;
	if (failureScenario === undefined && evidence === undefined) return [];
	return [
		{
			id,
			ruleId,
			source,
			...(failureScenario === undefined ? {} : { failureScenario }),
			...(evidence === undefined ? {} : { evidence }),
		},
	];
}

/**
 * The cause, evidence, failure scenario, and other claims of `members` merged as one defect that `speaker`, one of
 * them, speaks for. The speaker keeps its own failure scenario and evidence. The cause is the strongest any member
 * has, in the order `introduced`, `affected` with a `cause` location, `pre-existing`, so merging never turns a finding
 * that blocks into one that does not. When a member other than the speaker proves it, the most severe such member, the
 * lower ID on a tie, adds its `cause` locations to the speaker's evidence, ten locations in all, those marked
 * `proves` first, so the cause travels with its proof. Every other member's failure scenario and evidence, and any claims it already carries, are kept whole
 * in `otherClaims`, so a verifier judges each claim with its own proof. Throws `RangeError` when `members` omits
 * `speaker`.
 */
export function mergeClaims(
	speaker: Claimant,
	members: readonly Claimant[],
): Pick<FindingProperties, "cause" | "evidence" | "failureScenario" | "otherClaims"> {
	if (!members.includes(speaker)) throw new RangeError("mergeClaims needs the speaker among the members");
	const best = Math.min(...members.map(causeRank));
	const prover =
		causeRank(speaker) === best
			? speaker
			: [...members].filter((member) => causeRank(member) === best).sort(strongerFirst)[0]!;
	const { failureScenario } = speaker.properties;
	const proof = prover === speaker ? [] : (prover.properties.evidence ?? []).filter((each) => each.role === "cause");
	const evidence = withProof(speaker.properties.evidence, proof);
	const otherClaims = [
		...(speaker.properties.otherClaims ?? []),
		...members
			.filter((member) => member !== speaker)
			.flatMap((member) => [...claimOf(member), ...(member.properties.otherClaims ?? [])]),
	];
	return {
		cause: (["introduced", "affected", "pre-existing"] as const)[best]!,
		...(evidence === undefined ? {} : { evidence }),
		...(failureScenario === undefined ? {} : { failureScenario }),
		...(otherClaims.length === 0 ? {} : { otherClaims }),
	};
}

// The speaker of a merged defect: the highest severity any member reported, and the merged claims.
function speakFor(keeper: Finding, defect: readonly Finding[], alsoReportedAs: AlsoReportedAs[]): Finding {
	const severity = [...defect].sort(strongerFirst)[0]!.properties.severity;
	const { evidence: _, failureScenario: __, otherClaims: ___, ...properties } = keeper.properties;
	return {
		...keeper,
		level: levelForSeverity(severity),
		properties: { ...properties, ...mergeClaims(keeper, defect), severity, alsoReportedAs },
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
 * severity among them and the strongest cause, keeps its own claim and every other's ({@link mergeClaims}), so a merge
 * never lowers what blocks and drops no claim, and lists each other's ID, rule, check, and severity in
 * `properties.alsoReportedAs`. A finding without a snippet is never merged.
 *
 * Only findings with the same lifecycle status merge. A dismissed finding never absorbs a live one: a live finding
 * beside a dismissed report of the same defect stays live, and blocks if it blocks, listing the dismissed one in
 * `alsoReportedAs` with `dismissed: true`. Returns the findings that stay, in input order.
 */
export function dedupeFindings(
	findings: readonly Finding[],
	configFor: (path: string) => Pick<MelianConfig, "ruleAliases">,
): Finding[] {
	// Whether `finding` reports the defect `defect` holds, whatever the statuses.
	const joins = (defect: readonly Finding[], finding: Finding) => {
		const site = siteOf(finding);
		const aliases = configFor(finding.properties.path).ruleAliases;
		return (
			site !== undefined &&
			siteOf(defect[0]!) === site &&
			defect.every(
				(member) =>
					member.properties.source.check !== finding.properties.source.check &&
					!distinct(aliases, member.ruleId, finding.ruleId),
			) &&
			defect.some((member) => overlap(member, finding))
		);
	};
	const defects: Finding[][] = [];
	for (const finding of [...findings].sort(strongerFirst)) {
		const into = defects.find(
			(defect) => defect[0]!.properties.status === finding.properties.status && joins(defect, finding),
		);
		if (into === undefined) defects.push([finding]);
		else into.push(finding);
	}
	const dismissed = findings.filter((finding) => finding.properties.status === "dismissed");
	const speakers = new Map<Finding, Finding>();
	for (const defect of defects) {
		// A live defect names the dismissed reports of it, for context, and is never absorbed by them.
		const context =
			defect[0]!.properties.status === "dismissed"
				? []
				: dismissed
						.filter((other) => joins(defect, other))
						.map((other) => ({ ...reportOf(other), dismissed: true as const }));
		if (defect.length === 1 && context.length === 0) {
			speakers.set(defect[0]!, defect[0]!);
			continue;
		}
		const keeper = keeperOf(defect, configFor(defect[0]!.properties.path).ruleAliases);
		const alsoReportedAs = [
			...(keeper.properties.alsoReportedAs ?? []),
			...defect
				.filter((member) => member !== keeper)
				.flatMap((member) => [reportOf(member), ...(member.properties.alsoReportedAs ?? [])]),
			...context,
		];
		speakers.set(keeper, speakFor(keeper, defect, alsoReportedAs));
	}
	return findings.flatMap((finding) => {
		const speaker = speakers.get(finding);
		return speaker === undefined ? [] : [speaker];
	});
}

/**
 * Whether a check ran to completion, was skipped, failed, or was `ended` by its budget before it finished: a lens whose
 * level does not count a budget's end as a run.
 */
export type CheckStatus = "ran" | "skipped" | "failed" | "ended";

/**
 * Which budget ended a lens's conversation, and its limit, with what the lens had used of each when it ended: input and
 * output tokens, and tool calls counted against the budget.
 */
export interface BudgetEnd {
	readonly budget: "tokens" | "tools";
	readonly limit: number;
	readonly tokens: number;
	readonly tools: number;
}

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
	/** The scrutiny level a lens ran at, or was to run at when it failed. Other checks have none. */
	readonly level?: ScrutinyLevel;
	/**
	 * The budget that ended a lens's conversation before the lens finished on its own, with what it had used: on an
	 * `ended` record, or on a `ran` record when the lens's level counts a budget's end as a run.
	 */
	readonly budgetEnded?: BudgetEnd;
}

/** The reason {@link adjudicate} gives a check the manifest names that has no record. */
export const noRecord = "no record";

/**
 * A review's outcome, as a pull request's check reports it: `passed` when every check ran and nothing needs
 * attention, `findings` when every check ran and something does, and `not-reviewed` when a check failed, was ended by
 * its budget, or was skipped without leave. A review that did not complete is never `passed`.
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
	 * The checks that were skipped, failed, or ended by their budget, with their reasons, in input order, then each check
	 * the manifest names that left no record, as skipped with the reason {@link noRecord}.
	 */
	readonly notRun: readonly CheckRecord[];
	/**
	 * The checks that ran, in input order, each lens with the level it ran at and any budget that ended it. Absent from a
	 * verdict recorded before Melian kept it.
	 */
	readonly ran?: readonly CheckRecord[];
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
 * as `silent` for lacking one. A failed check, one its budget ended, a skipped one not in `allowSkip`, or a check of
 * the manifest with no record makes the review `not-reviewed`, even with no findings. Otherwise a finding above `silent` makes it
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
		missing.length > 0 || notRun.some((check) => check.status !== "skipped" || !allowSkip.includes(check.name));
	const attention = counted.some((finding) => finding.properties.resolution !== "silent");
	return {
		status: incomplete ? "not-reviewed" : attention ? "findings" : "passed",
		blocking: grouped.block.length > 0,
		findings: grouped,
		dismissed: resolved.filter((finding) => finding.properties.status === "dismissed"),
		notRun,
		ran: checks.filter((check) => check.status === "ran").map((check) => ({ ...check })),
	};
}
