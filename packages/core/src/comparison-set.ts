import type { CheckRecord, Verdict } from "./adjudication.ts";
import type { Comparison } from "./comparison.ts";
import { type ComparisonAdjudicationRecord, missReasons } from "./comparison-adjudication.ts";
import { visibleText } from "./render.ts";
import { VerificationState } from "./verification.ts";

/** Counts for one reviewer; pending reports enter neither precision nor recall. */
export interface ReviewerStats {
	readonly reviewer: string;
	readonly found: number;
	readonly total: number;
	readonly valid: number;
	readonly noise: number;
	readonly duplicate: number;
	readonly pending: number;
	readonly recall: number;
	readonly precision: number;
}

/** Adjudicated counts for one or several comparisons. */
export interface ComparisonStats {
	readonly reviewers: readonly ReviewerStats[];
	readonly pendingMatches: number;
	readonly reasonlessMisses: number;
	readonly misses: Record<(typeof missReasons)[number], number>;
}

/**
 * One check's findings against one external reviewer's, over the valid defects either found. A Melian finding is the
 * check's when the check reported it or a report merged into it. A defect only another of Melian's checks found
 * counts apart, so it is no miss of the check's.
 */
export interface CheckAgainstReviewer {
	readonly check: string;
	readonly reviewer: string;
	/** Changesets with a stored review to attribute Melian's findings to. */
	readonly comparisons: number;
	/** The reviewer's valid defects, and how many the check also found. */
	readonly reviewerValid: number;
	readonly checkFound: number;
	/** The reviewer's valid defects only Melian's other checks found. */
	readonly othersFound: number;
	/** The check's valid defects, and how many the reviewer also found. */
	readonly checkValid: number;
	readonly reviewerFound: number;
	/** Findings, the reviewer's and the check's, left out while one of their reports waits for a judgement or a hand match. */
	readonly pending: number;
}

/** A golden the current maintainer judgement owes. */
export interface OwedGolden {
	readonly changeset: string;
	readonly target: string;
	readonly id: string;
	readonly title: string;
	readonly lens: string;
	readonly verdict: string;
	readonly at: string;
}

/** Findings sharing a rule tag or normalised title. */
export interface RepeatedFinding {
	readonly key: string;
	readonly title: string;
	readonly ids: readonly string[];
	readonly changesets: readonly string[];
}

/** A comparison beside its changeset identity and stored review; findings remain in the review. */
export interface ComparisonEntry {
	readonly changeset: string;
	readonly comparison: Comparison;
	readonly round?: string;
	readonly unattributed?: string;
	readonly verdict?: Verdict;
}

/** Several changesets' local comparisons, including their earlier rounds. */
export class ComparisonSet {
	private readonly entries: readonly ComparisonEntry[];
	private readonly unattributed: number;

	constructor(entries: readonly ComparisonEntry[]) {
		this.entries = [...entries];
		this.unattributed = entries.filter((entry) => entry.unattributed !== undefined).length;
	}

	/** Selects whole changesets by the time their first comparison was recorded, newest last. */
	select(options: { readonly since?: string; readonly last?: number }): ComparisonSet {
		const times = new Map<string, string>();
		for (const { changeset, comparison } of this.entries) {
			const at = comparison.recordedAt() ?? "";
			if (!times.has(changeset) || Date.parse(at) < Date.parse(times.get(changeset)!)) times.set(changeset, at);
		}
		let selected = [...times]
			.filter(([, at]) => options.since === undefined || Date.parse(at) >= Date.parse(options.since))
			.sort((a, b) => (Date.parse(a[1]) || 0) - (Date.parse(b[1]) || 0) || a[0].localeCompare(b[0]));
		if (options.last !== undefined) selected = selected.slice(-options.last);
		const ids = new Set(selected.map(([id]) => id));
		return new ComparisonSet(this.entries.filter((entry) => ids.has(entry.changeset)));
	}

	/** Sums counts before dividing, so a large review weighs more than a clean one. */
	stats(): ComparisonStats {
		const counts = new Map<string, ReviewerStats>();
		let pendingMatches = 0;
		let reasonlessMisses = 0;
		const misses = Object.fromEntries(missReasons.map((reason) => [reason, 0])) as ComparisonStats["misses"];
		for (const { comparison } of this.entries.filter((entry) => entry.unattributed === undefined)) {
			const stats = comparison.stats();
			pendingMatches += stats.pendingMatches;
			reasonlessMisses += stats.reasonlessMisses;
			for (const next of stats.reviewers) {
				const previous = counts.get(next.reviewer);
				counts.set(
					next.reviewer,
					previous === undefined
						? next
						: {
								...next,
								found: next.found + previous.found,
								total: next.total + previous.total,
								valid: next.valid + previous.valid,
								noise: next.noise + previous.noise,
								duplicate: next.duplicate + previous.duplicate,
								pending: next.pending + previous.pending,
							},
				);
			}
			for (const reason of missReasons) misses[reason] += stats.misses[reason];
		}
		return {
			pendingMatches,
			reasonlessMisses,
			reviewers: [...counts.values()]
				.sort((a, b) => a.reviewer.localeCompare(b.reviewer))
				.map((each) => ({
					...each,
					recall: each.total === 0 ? 1 : each.found / each.total,
					precision:
						each.valid + each.noise + each.duplicate === 0
							? 1
							: each.valid / (each.valid + each.noise + each.duplicate),
				})),
			misses,
		};
	}

	/**
	 * How `check`, such as `lens.design`, compares with `reviewer`, such as `codex`, over the comparisons with a stored
	 * review: which of the reviewer's valid defects the check found, and which of the check's the reviewer found.
	 */
	againstReviewer(check: string, reviewer: string, cohort?: string): CheckAgainstReviewer {
		const counts = { reviewerValid: 0, checkFound: 0, othersFound: 0, checkValid: 0, reviewerFound: 0, pending: 0 };
		let comparisons = 0;
		for (const { comparison, verdict, unattributed } of this.entries) {
			if (verdict === undefined || unattributed !== undefined) continue;
			if (cohort !== undefined && cohortOf(verdict.ran, check) !== cohort) continue;
			// A round the reviewer took no part in says nothing about what it would have found. An import an older Melian
			// stored names no participants, so a finding of the reviewer's also shows it took part.
			const imported = Object.values(comparison.importsBySource()).flatMap((each) => each.reviewers ?? []);
			const took = [...imported, ...comparison.externalFindings().map((finding) => finding.reviewer)];
			if (!took.some((each) => each.name === reviewer)) continue;
			comparisons++;
			const mine = new Set(
				verdict
					.all()
					.filter((finding) => {
						// The verdict's defect names its live members: a dismissed co-report stays on the finding as context.
						const { source, reportedBy = [source] } = finding.properties;
						const members = verdict.defect(finding.id)?.members ?? [];
						if (![...reportedBy, ...members].some((each) => each.check === check)) return false;
						// A lens whose every claim on the finding the verifier refuted did not find it, whoever else did.
						const claims = VerificationState.from(finding).claims.filter((claim) => claim.source.check === check);
						return claims.length === 0 || claims.some((claim) => claim.verification?.verdict !== "refuted");
					})
					.map((finding) => finding.id),
			);
			const ambiguous = new Set(comparison.ambiguous().map((each) => each.external.id));
			const matches = comparison.effectiveMatches();
			const settled = (id: string) => !ambiguous.has(id) && comparison.judgement(id) !== undefined;
			const valid = (id: string) => comparison.judgement(id)?.verdict === "valid";
			const theirs = comparison.externalFindings().filter((finding) => finding.reviewer.name === reviewer);
			const theirIds = new Set(theirs.map((finding) => finding.id));
			// Each finding counts once, whatever groups it sits in: an external finding matched with two of Melian's sits
			// beside each of them.
			for (const { id } of theirs) {
				const melian = matches.filter((match) => match.external === id).map((match) => match.melian);
				if (![id, ...melian].every(settled)) {
					counts.pending++;
					continue;
				}
				if (!valid(id)) continue;
				if (melian.length === 0 && comparison.adjudication(id)?.current.reason === "out-of-scope") continue;
				counts.reviewerValid++;
				if (melian.some((each) => mine.has(each) && valid(each))) counts.checkFound++;
				else if (melian.some(valid)) counts.othersFound++;
			}
			for (const id of new Set(comparison.groups().flatMap((group) => group.melian))) {
				if (!mine.has(id)) continue;
				const external = matches
					.filter((match) => match.melian === id && theirIds.has(match.external))
					.map((match) => match.external);
				if (![id, ...external].every(settled)) {
					counts.pending++;
					continue;
				}
				if (!valid(id)) continue;
				counts.checkValid++;
				if (external.some(valid)) counts.reviewerFound++;
			}
		}
		return { check, reviewer, comparisons, ...counts };
	}

	/**
	 * Current debt once per changeset and finding, taking its newest judgement across rounds, even from a round that
	 * has since dropped the finding. A discharged golden stays discharged; a finding no round of the changeset holds owes nothing.
	 */
	backlog(): OwedGolden[] {
		const latest = new Map<string, { entry: ComparisonEntry; id: string; record: ComparisonAdjudicationRecord }>();
		for (const entry of this.entries) {
			for (const [id, record] of Object.entries(entry.comparison.judgedIncludingWithdrawn())) {
				const key = JSON.stringify([entry.changeset, id]);
				if (!latest.has(key) || Date.parse(record.current.at) > Date.parse(latest.get(key)!.record.current.at))
					latest.set(key, { entry, id, record });
			}
		}
		return [...latest.values()]
			.flatMap(({ entry, id, record }) =>
				!this.entries.some((each) => each.changeset === entry.changeset && each.comparison.holds(id)) ||
				record.current.golden === undefined ||
				record.current.golden === "none"
					? []
					: [
							{
								changeset: entry.changeset,
								target: entry.comparison.label(),
								id,
								title: this.titleOf(entry, id),
								lens: record.current.golden,
								verdict: record.current.verdict,
								at: record.current.at,
							},
						],
			)
			.sort((a, b) => a.lens.localeCompare(b.lens) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id));
	}

	private titleOf(judged: ComparisonEntry, id: string): string {
		const holders = this.entries.filter((each) => each.changeset === judged.changeset && each.comparison.holds(id));
		for (const each of [judged, ...holders.reverse()]) {
			const title =
				each.comparison.externalFinding(id)?.title ??
				each.verdict?.all().find((finding) => finding.id === id)?.properties.explanation.what;
			if (title !== undefined) return title;
		}
		return id;
	}

	/** Clusters seen on at least two changesets are candidate checks, irrespective of review rounds. */
	candidates(): RepeatedFinding[] {
		const clusters = new Map<string, { title: string; ids: Set<string>; changesets: Set<string> }>();
		for (const { changeset, comparison, verdict } of this.entries) {
			const missed = new Set(
				comparison.externalOnly().flatMap((group) => group.external.map((finding) => finding.id)),
			);
			for (const repeat of comparison.repeats(verdict)) {
				if (!repeat.ids.some((id) => missed.has(id) && comparison.judgement(id)?.verdict === "valid")) continue;
				const cluster = clusters.get(repeat.key) ?? {
					title: repeat.title,
					ids: new Set<string>(),
					changesets: new Set<string>(),
				};
				for (const id of repeat.ids) cluster.ids.add(id);
				cluster.changesets.add(changeset);
				clusters.set(repeat.key, cluster);
			}
		}
		return [...clusters]
			.filter(([, cluster]) => cluster.changesets.size >= 2)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, cluster]) => ({
				key,
				title: cluster.title,
				ids: [...cluster.ids].sort(),
				changesets: [...cluster.changesets].sort(),
			}));
	}

	/** Every third changeset's comparison owes a drain while goldens remain; rounds never advance the counter. */
	drain(): { comparisons: number; due: boolean; goldens: number; next: number } {
		const comparisons = new Set(
			this.entries.filter((entry) => entry.unattributed === undefined).map((entry) => entry.changeset),
		).size;
		const owed = this.backlog().length;
		return {
			comparisons,
			due: comparisons >= 3 && owed > 0,
			goldens: Math.min(2, owed),
			next: (Math.floor(comparisons / 3) + 1) * 3,
		};
	}

	/** The CLI's per-reviewer arithmetic, reasons, candidate checks, and drain notice. */
	renderStats(options: { readonly since?: string; readonly last?: number; readonly drain?: boolean } = {}): string {
		const selected = this.select(options);
		const includeDrain = options.drain ?? true;
		const stats = this.stats();
		const metrics = selected.stats();
		const drain = this.drain();
		const filtered = options.since !== undefined || options.last !== undefined;
		const out = [
			filtered
				? `Comparisons: ${selected.drain().comparisons}.\n`
				: `Comparisons: ${selected.drain().comparisons}. Pending matches: ${stats.pendingMatches}.\n`,
		];
		if (this.unattributed > 0) out.push(`Unattributed comparisons: ${this.unattributed}.\n`);
		for (const each of metrics.reviewers)
			out.push(
				`${visibleText(each.reviewer)}: recall ${each.found}/${each.total} (${each.recall.toFixed(3)}), precision ${each.valid}/${each.valid + each.noise + each.duplicate} (${each.precision.toFixed(3)}), pending ${each.pending}.\n`,
			);
		if (filtered) out.push(`Clone-wide, not narrowed by the filter:\nPending matches: ${stats.pendingMatches}.\n`);
		for (const reason of missReasons) out.push(`${reason}: ${stats.misses[reason]}.\n`);
		out.push(`Valid misses without a reason: ${stats.reasonlessMisses}.\n`);
		for (const candidate of this.candidates())
			out.push(
				`Candidate check: ${visibleText(candidate.key)}, seen on ${candidate.changesets.length} changesets (${candidate.changesets.map(visibleText).join(", ")}).\n`,
			);
		if (includeDrain)
			out.push(
				drain.due
					? `Drain due: ship ${drain.goldens} owed goldens and re-measure their lenses.\n`
					: `Drain not due; next comparison threshold: ${drain.next}.\n`,
			);
		return out.join("");
	}

	/** {@link ComparisonSet.againstReviewer} as the CLI prints it, over the changesets `options` selects. */
	renderAgainst(
		check: string,
		reviewer: string,
		options: { readonly since?: string; readonly last?: number } = {},
	): string {
		// A round counts by its own time: a pull request whose first round predates `since` keeps its later rounds.
		const rounds =
			options.since === undefined
				? this
				: new ComparisonSet(
						this.entries.filter(
							(entry) => Date.parse(entry.comparison.recordedAt() ?? "") >= Date.parse(options.since!),
						),
					);
		const selected = rounds.select({ ...(options.last === undefined ? {} : { last: options.last }) });
		const cohorts = [
			...new Set(
				selected.entries.flatMap(({ verdict, unattributed }) =>
					verdict === undefined || unattributed !== undefined ? [] : [cohortOf(verdict.ran, check)],
				),
			),
		];
		const name = visibleText(check);
		const them = visibleText(reviewer);
		const share = (part: number, whole: number) => (whole === 0 ? "" : ` (${(part / whole).toFixed(3)})`);
		const block = (stats: CheckAgainstReviewer, lead: string) => {
			const missed = stats.reviewerValid - stats.checkFound - stats.othersFound;
			return [
				`${lead}over ${stats.comparisons} comparisons with a stored review.\n`,
				`${them}'s valid defects: ${stats.reviewerValid}. ${name} found ${stats.checkFound}${share(stats.checkFound, stats.reviewerValid)}; only Melian's other checks found ${stats.othersFound}; no check found ${missed}.\n`,
				`${name}'s valid defects: ${stats.checkValid}. ${them} found ${stats.reviewerFound}${share(stats.reviewerFound, stats.checkValid)}.\n`,
				`Findings left out while a report waits for a judgement or a hand match: ${stats.pending}.\n`,
			].join("");
		};
		if (cohorts.length <= 1) return block(selected.againstReviewer(check, reviewer), `${name} against ${them}, `);
		return [
			`${name} against ${them}, by the lens's version, level and route.\n`,
			...cohorts.map(
				(cohort) => `\n${block(selected.againstReviewer(check, reviewer, cohort), `${visibleText(cohort)}: `)}`,
			),
		].join("");
	}

	/** The generated section replacing generated entries after BACKLOG.md's frozen entries, or a terminal list. */
	renderBacklog(markdown = false): string {
		const owed = this.backlog();
		if (!markdown)
			return owed.length === 0
				? "No goldens owed.\n"
				: owed
						.map(
							(each) =>
								`${visibleText(each.lens)}: ${visibleText(each.target)} ${each.id} ${visibleText(each.title)} (${each.verdict}).\n`,
						)
						.join("");
		const out = [
			"## Stored comparison backlog\n\n",
			"Generated by `melian compare backlog --markdown`. The entries above remain frozen.\n\n",
		];
		if (owed.length === 0) out.push("No goldens owed.\n");
		for (const each of owed)
			out.push(
				`- ${markdownText(each.lens)}: ${markdownText(each.target)}, ${each.id}, ${markdownText(each.title)} (${each.verdict}).\n`,
			);
		return out.join("");
	}
}

// A table cell or list item is inert prose: no live HTML, markdown, mentions, autolinks, or forged lines. Mirrors
// `renderProse` in the github package, which core cannot import.
export function markdownText(text: string): string {
	return visibleText(text)
		.replace(/\\/g, "\\\\")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/[*_[\]()#!|~`]/g, "\\$&")
		.replace(/@(?=[\p{L}\p{N}_-])/gu, "@\u2060")
		.replace(/\\#(?=\d)/g, "\\#\u2060")
		.replace(/:(?=\/\/)/g, ":\u2060")
		.replace(/www\./gi, (match) => `${match.slice(0, -1)}\u2060.`)
		.replace(/\bGH-(?=\d)/gi, (match) => `${match}\u2060`);
}

// The lens as it ran in a round: the version and level its check record names, with the route when the round left the
// committed one, so rounds on a lens's earlier route never mix with its later ones.
function cohortOf(ran: readonly CheckRecord[] | undefined, check: string): string {
	const record = (ran ?? []).find((each) => each.name === check);
	if (record === undefined) return "no record of the lens";
	const lineage = record.lineage;
	const route =
		lineage === undefined ? "" : ` on ${lineage.model}${lineage.thinking ? ` at ${lineage.thinking.level}` : ""}`;
	return `${record.version ?? "unversioned"}@${record.level ?? "careful"}${route}`;
}
