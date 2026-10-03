import type { MelianConfig, Resolution, Severity } from "./config.ts";
import { type AlsoReportedAs, type Finding, normaliseSnippet } from "./findings.ts";

/** The resolutions from strictest to most lenient. */
export const resolutionOrder: readonly Resolution[] = ["block", "acknowledge", "advisory", "silent"];

/** The configuration that applies at a repository-relative path, usually through `loadConfig` for that path. */
export type ConfigFor = (path: string) => Pick<MelianConfig, "resolution" | "ruleAliases">;

function lenientOf(left: Resolution, right: Resolution): Resolution {
	return resolutionOrder.indexOf(left) > resolutionOrder.indexOf(right) ? left : right;
}

/**
 * What a finding requires under `config`, the effective configuration at the finding's path: the resolution configured
 * for its severity. A finding not shown to be caused by the change, `pre-existing` or `affected` without evidence, is
 * never above `advisory`, so an old defect cannot block an unrelated change.
 */
export function resolveFinding(finding: Finding, config: Pick<MelianConfig, "resolution">): Resolution {
	const { severity, cause, evidence } = finding.properties;
	const configured = config.resolution[severity];
	const caused = cause === "introduced" || (cause === "affected" && evidence !== undefined);
	return caused ? configured : lenientOf(configured, "advisory");
}

/**
 * Copies of `findings` with `properties.resolution` set by {@link resolveFinding}, each under the configuration
 * `configFor` returns for its path.
 */
export function applyResolutions(findings: readonly Finding[], configFor: ConfigFor): Finding[] {
	return findings.map((finding) => {
		const resolution = resolveFinding(finding, configFor(finding.properties.path));
		return { ...finding, properties: { ...finding.properties, resolution } };
	});
}

const rank: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

function aliased(left: string, right: string, aliases: MelianConfig["ruleAliases"]): boolean {
	if (left === right) return true;
	return Object.entries(aliases).some(([rule, others]) => {
		const group = [rule, ...others];
		return group.includes(left) && group.includes(right);
	});
}

// Where a finding sits: its file, its normalised snippet, and which of the identical snippets in that file it is.
function siteOf(finding: Finding): string | undefined {
	const { path, occurrence } = finding.properties;
	const snippet = normaliseSnippet(finding.locations[0]!.physicalLocation.region.snippet?.text ?? "");
	return snippet === "" ? undefined : JSON.stringify([path, snippet, occurrence]);
}

function reportOf(finding: Finding): AlsoReportedAs {
	return { id: finding.properties.id, ruleId: finding.ruleId, check: finding.properties.source.check };
}

/**
 * Merges findings that two checks reported for one problem. Two findings are one when different checks report them in
 * the same file, on the same normalised snippet at the same occurrence, under the same rule or rules that
 * `ruleAliases` in the configuration at that path lists together. The finding of higher severity stays, the lower ID
 * on a tie, and records each merged finding in `properties.alsoReportedAs`. A finding without a snippet is never
 * merged. Returns the findings that stay, in input order.
 */
export function dedupeFindings(
	findings: readonly Finding[],
	configFor: (path: string) => Pick<MelianConfig, "ruleAliases">,
): Finding[] {
	const strongestFirst = [...findings].sort(
		(a, b) =>
			rank[a.properties.severity] - rank[b.properties.severity] ||
			(a.properties.id < b.properties.id ? -1 : a.properties.id > b.properties.id ? 1 : 0),
	);
	const kept = new Map<Finding, Finding[]>();
	for (const finding of strongestFirst) {
		const site = siteOf(finding);
		const { ruleAliases } = configFor(finding.properties.path);
		const reporters = (members: Finding[]) =>
			members.some(
				(member) =>
					member.properties.source.check !== finding.properties.source.check &&
					aliased(member.ruleId, finding.ruleId, ruleAliases),
			);
		const into =
			site === undefined
				? undefined
				: [...kept].find(([keeper, members]) => siteOf(keeper) === site && reporters([keeper, ...members]));
		if (into === undefined) kept.set(finding, []);
		else into[1].push(finding);
	}
	return findings.flatMap((finding) => {
		const merged = kept.get(finding);
		if (merged === undefined) return [];
		if (merged.length === 0) return [finding];
		const alsoReportedAs = [
			...(finding.properties.alsoReportedAs ?? []),
			...merged.flatMap((each) => [reportOf(each), ...(each.properties.alsoReportedAs ?? [])]),
		];
		return [{ ...finding, properties: { ...finding.properties, alsoReportedAs } }];
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
}

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
	readonly findings: Readonly<Record<Resolution, readonly Finding[]>>;
	/** Findings dismissed with a reason. They neither block nor need attention. */
	readonly dismissed: readonly Finding[];
	/** The checks that were skipped or failed, with their reasons, in input order. */
	readonly notRun: readonly CheckRecord[];
}

/** What {@link adjudicate} decides from. */
export interface AdjudicationInput {
	/** Findings at the head under review, at most one per ID. */
	readonly findings: readonly Finding[];
	/** Every check the review called for, and what it did. */
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
 * its path's configuration ({@link applyResolutions}), and derives the status. A failed check, or a skipped one not in
 * `allowSkip`, makes the review `not-reviewed`, even with no findings. Otherwise a finding above `silent` makes it
 * `findings`, and nothing does `passed`. A dismissed finding counts toward neither.
 */
export function adjudicate({ findings, checks, config, allowSkip = [] }: AdjudicationInput): Verdict {
	const configFor = typeof config === "function" ? config : () => config;
	const resolved = applyResolutions(dedupeFindings(findings, configFor), configFor).sort(readingOrder);
	const counted = resolved.filter((finding) => finding.properties.status !== "dismissed");
	const grouped = Object.fromEntries(
		resolutionOrder.map((resolution) => [
			resolution,
			counted.filter((finding) => finding.properties.resolution === resolution),
		]),
	) as Record<Resolution, Finding[]>;
	const notRun = checks.filter((check) => check.status !== "ran").map((check) => ({ ...check }));
	const incomplete = notRun.some((check) => check.status === "failed" || !allowSkip.includes(check.name));
	const attention = counted.some((finding) => finding.properties.resolution !== "silent");
	return {
		status: incomplete ? "not-reviewed" : attention ? "findings" : "passed",
		blocking: grouped.block.length > 0,
		findings: grouped,
		dismissed: resolved.filter((finding) => finding.properties.status === "dismissed"),
		notRun,
	};
}
