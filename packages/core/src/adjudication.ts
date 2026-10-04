import { createHash } from "node:crypto";
import { type MelianConfig, type Resolution, type RuleAlias, resolutionOrder } from "./config.ts";
import {
	type AlsoReportedAs,
	Finding,
	type FindingDismissal,
	levelForSeverity,
	type ResolvedFinding,
	type StoredFinding,
} from "./findings.ts";
import type { ScrutinyLevel } from "./lens.ts";
import type {
	ClosedFinding,
	DiffLines,
	PlacedFinding,
	PublicationPlan,
	PublishedFinding,
	ReviewStatus,
} from "./publication.ts";
import { Rendering, type TerminalRenderOptions } from "./render.ts";

/**
 * The configuration that applies at a repository-relative path, usually through `loadConfig` for that path. Given
 * `rule`, the rule of a finding being resolved, it is the configuration that judged that rule at the path, which can
 * differ from the path's own: policy-change-review judges a `melian.yaml` under `ConfigLookup.policyReview`.
 */
export type ConfigFor = (path: string, rule?: string) => Pick<MelianConfig, "resolution" | "ruleAliases">;

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

/**
 * One defect, as a verdict holds it: the finding that speaks for it, and the reports adjudication merged into that
 * finding, which a dismissal of the defect dismisses with it. A dismissed report of the defect that the finding never
 * absorbed is listed in its `alsoReportedAs` with `dismissed: true`, and is no member.
 */
export class Defect {
	readonly speaker: Finding;
	readonly members: readonly AlsoReportedAs[];

	constructor(speaker: Finding, members: readonly AlsoReportedAs[]) {
		this.speaker = speaker;
		this.members = members;
	}

	/**
	 * Merges `findings`, the reports of one defect, under `keeper`, the one among them that speaks for it. The speaker
	 * takes the highest severity any of them reported and their merged claims ({@link Finding.mergeClaims}), so a merge
	 * never lowers what blocks and drops no claim. It lists each other report's ID, rule, check, and severity in
	 * `properties.alsoReportedAs`, then each report in `context`: the dismissed reports of the defect it never absorbed.
	 */
	static merge(keeper: Finding, findings: readonly Finding[], context: readonly AlsoReportedAs[]): Defect {
		const members = [
			...(keeper.properties.alsoReportedAs ?? []),
			...findings
				.filter((member) => member !== keeper)
				.flatMap((member) => [member.report(), ...(member.properties.alsoReportedAs ?? [])]),
		];
		const alsoReportedAs = [...members, ...context];
		const severity = [...findings].sort((a, b) => a.compareStrength(b))[0]!.properties.severity;
		const { evidence: _, failureScenario: __, otherClaims: ___, ...properties } = keeper.properties;
		const speaker = Finding.from({
			...keeper.toJSON(),
			level: levelForSeverity(severity),
			properties: { ...properties, ...keeper.mergeClaims(findings), severity, alsoReportedAs },
		});
		return new Defect(
			speaker,
			members.filter((member) => member.dismissed !== true),
		);
	}

	/**
	 * The IDs of the reports a dismissal records: the speaker's own and every member's, or the one report `only` names
	 * alone, leaving every other report live.
	 */
	dismiss(only?: string): string[] {
		return only !== undefined ? [only] : [this.speaker.id, ...this.members.map((member) => member.id)];
	}
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

/** The reason a {@link Manifest} gives a check it names that has no record. */
export const noRecord = "no record";

/**
 * Every check a review's tier names, as `checksOfTier` expands it, with what each check did and the checks whose skip
 * still lets the review pass, such as a tool with no files in its language to check. A check it names with no record
 * is one that never started.
 */
export class Manifest {
	readonly checks: readonly string[];
	readonly #records: CheckRecord[];
	readonly #allowSkip: string[];

	constructor(checks: readonly string[], records: readonly CheckRecord[] = [], allowSkip: readonly string[] = []) {
		this.checks = checks;
		this.#records = [...records];
		this.#allowSkip = [...allowSkip];
	}

	/** Records what one check did. Any check may have a record, named here or not. */
	record(check: CheckRecord): void {
		this.#records.push(check);
	}

	/** Lets the review pass with the named check skipped. */
	allowSkip(name: string): void {
		this.#allowSkip.push(name);
	}

	/** What each check did, in the order recorded. */
	records(): readonly CheckRecord[] {
		return this.#records;
	}

	/** The checks whose skip still lets the review pass. */
	skippable(): readonly string[] {
		return this.#allowSkip;
	}

	/** Each check the manifest names that has no record, once. */
	missing(): string[] {
		const recorded = new Set(this.#records.map((check) => check.name));
		return [...new Set(this.checks)].filter((name) => !recorded.has(name));
	}

	/**
	 * The checks that were skipped, failed, or ended by their budget, with their reasons, in record order, then each
	 * check the manifest names that left no record, as skipped with the reason {@link noRecord}.
	 */
	notRun(): CheckRecord[] {
		return [
			...this.#records.filter((check) => check.status !== "ran").map((check) => ({ ...check })),
			...this.missing().map((name) => ({ name, status: "skipped" as const, reason: noRecord })),
		];
	}

	/** The checks that ran, in record order. */
	ran(): CheckRecord[] {
		return this.#records.filter((check) => check.status === "ran").map((check) => ({ ...check }));
	}

	/**
	 * Whether the review completed: every check it names has a record, and none failed, was ended by its budget, or was
	 * skipped without leave.
	 */
	complete(): boolean {
		const notRun = this.notRun();
		return (
			this.missing().length === 0 &&
			!notRun.some((check) => check.status !== "skipped" || !this.#allowSkip.includes(check.name))
		);
	}
}

/**
 * A review's outcome, as a pull request's check reports it: `passed` when every check ran and nothing needs
 * attention, `findings` when every check ran and something does, and `not-reviewed` when a check failed, was ended by
 * its budget, or was skipped without leave. A review that did not complete is never `passed`.
 */
export type VerdictStatus = "passed" | "findings" | "not-reviewed";

/** A {@link CheckRecord} as JSON, which a Pi Durable document can hold. */
export type StoredCheckRecord = {
	name: string;
	status: CheckStatus;
	reason?: string;
	error?: string;
	version?: string;
	level?: ScrutinyLevel;
	budgetEnded?: { budget: "tokens" | "tools"; limit: number; tokens: number; tools: number };
};

/** A {@link Verdict} as JSON, which a Pi Durable document can hold. */
export type StoredVerdict = {
	status: VerdictStatus;
	blocking: boolean;
	findings: Record<Resolution, StoredFinding[]>;
	dismissed: StoredFinding[];
	notRun: StoredCheckRecord[];
	// Absent from a verdict recorded before Melian kept the checks that ran.
	ran?: StoredCheckRecord[];
};

/** What a {@link Verdict} holds. */
export interface VerdictFields {
	readonly status: VerdictStatus;
	readonly blocking: boolean;
	readonly findings: Readonly<Record<Resolution, readonly ResolvedFinding[]>>;
	readonly dismissed: readonly ResolvedFinding[];
	readonly notRun: readonly CheckRecord[];
	readonly ran?: readonly CheckRecord[];
}

/** What a review concluded: a runtime view over a {@link StoredVerdict}. */
export class Verdict {
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

	// Declared in the order a stored verdict holds them, so its JSON, and its fingerprint, is unchanged.
	constructor(fields: VerdictFields) {
		this.status = fields.status;
		this.blocking = fields.blocking;
		this.findings = fields.findings;
		this.dismissed = fields.dismissed;
		this.notRun = fields.notRun;
		this.ran = fields.ran;
	}

	/** The verdict a stored one describes, trusted as stored. */
	static from(stored: StoredVerdict): Verdict {
		const resolved = (finding: StoredFinding) => Finding.from(finding) as ResolvedFinding;
		const findings = Object.fromEntries(
			Object.entries(stored.findings).map(([resolution, group]) => [resolution, group.map(resolved)]),
		) as Record<Resolution, ResolvedFinding[]>;
		return new Verdict({ ...stored, findings, dismissed: stored.dismissed.map(resolved) });
	}

	/** A verdict stored before evidence became a list, each finding in the current shape by {@link Finding.upgrade}. */
	static upgrade(stored: StoredVerdict): StoredVerdict {
		const findings = Object.fromEntries(
			Object.entries(stored.findings).map(([resolution, group]) => [
				resolution,
				group.map((finding) => Finding.upgrade(finding)),
			]),
		) as StoredVerdict["findings"];
		return { ...stored, findings, dismissed: stored.dismissed.map((finding) => Finding.upgrade(finding)) };
	}

	/** The findings that need attention: those that resolve to `block`, `acknowledge`, or `advisory`. */
	attention(): ResolvedFinding[] {
		return [...this.findings.block, ...this.findings.acknowledge, ...this.findings.advisory];
	}

	/** Every finding the verdict holds, by resolution, strictest first, then the dismissed ones. */
	all(): ResolvedFinding[] {
		return [...Object.values(this.findings).flat(), ...this.dismissed];
	}

	/**
	 * The defect a finding's ID names: the finding with that ID, else the one it was merged into, with the reports merged
	 * into that finding. A live finding's `alsoReportedAs` also lists the dismissed reports of its defect, which it never
	 * absorbed, so they neither lead to it nor are members. A verdict recorded before Melian marked those reports
	 * `dismissed` still lists each among its own dismissed findings. `undefined` when no finding has the ID.
	 */
	defect(id: string): Defect | undefined {
		const dismissed = new Set(
			this.dismissed.flatMap((each) => [
				each.id,
				...(each.properties.alsoReportedAs ?? []).map((other) => other.id),
			]),
		);
		const membersOf = ({ properties }: Finding) =>
			(properties.alsoReportedAs ?? []).filter(
				(other) => properties.status === "dismissed" || (other.dismissed !== true && !dismissed.has(other.id)),
			);
		const all = this.all();
		const finding =
			all.find((each) => each.id === id) ?? all.find((each) => membersOf(each).some((other) => other.id === id));
		return finding === undefined ? undefined : new Defect(finding, membersOf(finding));
	}

	/**
	 * Decides what a revision's publication of the verdict posts, given the findings open on the pull request after the
	 * previous revision's publication, and the lines the revision changes.
	 *
	 * Findings that resolve to `block`, `acknowledge`, or `advisory` need attention. One not already open is posted; one
	 * already open is not posted again. An open finding the verdict no longer holds in any group, silent and dismissed
	 * included, is resolved. An open finding the verdict holds as dismissed, itself or merged into a dismissed finding,
	 * is resolved with that dismissal, so its thread says why, and leaves `open`: if a changed trigger reopens it, it is
	 * posted afresh. A dismissed finding is never posted. An open finding that turned silent stays in `open`, so if it
	 * needs attention again it returns to its own thread rather than starting a second one.
	 */
	publication(
		previous: Readonly<Record<string, PublishedFinding>>,
		lines: DiffLines,
		revision: string,
	): PublicationPlan {
		const attention = this.attention();
		const dismissals: Record<string, FindingDismissal> = {};
		for (const { properties } of this.dismissed) {
			if (properties.dismissal === undefined) continue;
			for (const { id, dismissal = properties.dismissal } of [properties, ...(properties.alsoReportedAs ?? [])]) {
				dismissals[id] ??= { ...dismissal };
			}
		}
		const held = new Set([...attention, ...this.findings.silent].map((finding) => finding.properties.id));
		const post: PlacedFinding[] = [];
		const stillOpen: string[] = [];
		const open: Record<string, PublishedFinding> = {};
		for (const finding of attention) {
			const { id, path } = finding.properties;
			if (Object.hasOwn(previous, id)) {
				stillOpen.push(id);
				open[id] = previous[id]!;
				continue;
			}
			post.push({ finding, placement: finding.place(lines) });
			open[id] = { ruleId: finding.ruleId, path, line: finding.lines()[0], revision };
		}
		for (const id of held) {
			if (!Object.hasOwn(open, id) && Object.hasOwn(previous, id)) open[id] = previous[id]!;
		}
		const resolved = Object.keys(previous)
			.sort()
			.filter((id) => !held.has(id))
			.map((id): ClosedFinding => {
				const dismissal = Object.hasOwn(dismissals, id) ? dismissals[id] : undefined;
				return { id, ...previous[id]!, ...(dismissal === undefined ? {} : { dismissal: { ...dismissal } }) };
			});
		return { post, stillOpen, resolved, open, dismissals };
	}

	/**
	 * The status a pull request's check shows for the verdict. A review that passed, or found nothing blocking, is
	 * `success`, with the count of findings; one with a blocking finding is `failure`; one that did not complete is
	 * `error`, naming what did not run. Melian never approves, so `success` means only that nothing blocks.
	 */
	reviewStatus(): ReviewStatus {
		const count = (number: number, noun: string) => `${number} ${noun}${number === 1 ? "" : "s"}`;
		if (this.status === "not-reviewed") {
			const reasons = this.notRun.map(
				({ name, status, reason }) => `${name} ${status}${reason === undefined ? "" : ` (${reason})`}`,
			);
			return { state: "error", description: `Not reviewed: ${reasons.join("; ") || "the review did not complete"}` };
		}
		const shown = this.attention().length;
		if (this.status === "passed" || shown === 0) return { state: "success", description: "Passed" };
		if (this.blocking) {
			return { state: "failure", description: `${count(shown, "finding")}, ${this.findings.block.length} blocking` };
		}
		return { state: "success", description: `${count(shown, "finding")}, none blocking` };
	}

	/**
	 * The verdict's fingerprint: the first 16 hex digits of a SHA-256 over its JSON, which names the verdict a review
	 * posted. Who dismissed each finding, why, and when stay out of it, a merged report's own dismissal included: a
	 * reason changed by a second dismissal is answered in the finding's thread, and a review saying nothing new would
	 * only repeat the last one. A verdict without dismissals hashes as it always has.
	 */
	fingerprint(): string {
		const bare = (finding: Finding): StoredFinding => {
			const { dismissal: _, pastDismissals: __, ...properties } = finding.properties;
			const { alsoReportedAs } = properties;
			if (alsoReportedAs === undefined) return { ...finding.toJSON(), properties };
			const reports = alsoReportedAs.map(({ dismissal: ___, ...report }) => report);
			return { ...finding.toJSON(), properties: { ...properties, alsoReportedAs: reports } };
		};
		const findings = Object.fromEntries(
			Object.entries(this.findings).map(([resolution, group]) => [resolution, group.map(bare)]),
		);
		const kept = { ...this.toJSON(), findings, dismissed: this.dismissed.map(bare) };
		return createHash("sha256").update(JSON.stringify(kept)).digest("hex").slice(0, 16);
	}

	/**
	 * The fingerprint the verdict had before it was migrated from version 2 of the verdict document, when it could have
	 * been one: each finding's evidence is the single cause at head that the migration made of its one location, and no
	 * finding has a failure scenario. A head published before the upgrade then reads as published, rather than taking a
	 * second review of the same verdict. `undefined` for a verdict no older Melian could have recorded.
	 */
	legacyFingerprint(): string | undefined {
		const legacy = (finding: Finding) => {
			const { evidence, failureScenario, otherClaims } = finding.properties;
			if (failureScenario !== undefined || otherClaims !== undefined) return false;
			if (evidence === undefined) return true;
			return evidence.length === 1 && evidence[0]!.role === "cause" && evidence[0]!.revision === "head";
		};
		if (!this.all().every(legacy)) return undefined;
		const downgrade = (finding: Finding) => {
			const [location] = finding.properties.evidence ?? [];
			if (location === undefined) return finding.toJSON();
			const { role: _, revision: __, ...old } = location;
			return { ...finding.toJSON(), properties: { ...finding.properties, evidence: old } };
		};
		const groups = Object.fromEntries(
			Object.entries(this.findings).map(([resolution, group]) => [resolution, group.map(downgrade)]),
		);
		const old = { ...this.toJSON(), findings: groups, dismissed: this.dismissed.map(downgrade) };
		return createHash("sha256").update(JSON.stringify(old)).digest("hex").slice(0, 16);
	}

	/** The verdict as plain text for a terminal, as {@link Rendering} renders it. */
	render(options: TerminalRenderOptions = {}): string {
		return new Rendering(options).verdict(this);
	}

	/** The verdict as JSON text, indented by two spaces and ending in a newline. Its findings are SARIF results. */
	renderJson(): string {
		return `${JSON.stringify(this, null, 2)}\n`;
	}

	/** The verdict as it is stored. */
	toJSON(): StoredVerdict {
		const stored = (finding: Finding) => finding.toJSON();
		const findings = Object.fromEntries(
			Object.entries(this.findings).map(([resolution, group]) => [resolution, group.map(stored)]),
		) as StoredVerdict["findings"];
		return {
			status: this.status,
			blocking: this.blocking,
			findings,
			dismissed: this.dismissed.map(stored),
			notRun: [...this.notRun],
			...(this.ran === undefined ? {} : { ran: [...this.ran] }),
		};
	}
}

/** What an {@link Adjudication} decides from. */
export interface AdjudicationInput {
	/** Findings at the head under review, at most one per ID. */
	readonly findings: readonly Finding[];
	/**
	 * Every check the review's tier names, as `checksOfTier` expands it. Each must have a record in `checks`; one without
	 * is a check that never started, and the review is `not-reviewed`.
	 */
	readonly manifest: readonly string[];
	/** What each check did: every check of the manifest, and any other the review ran. */
	readonly checks: readonly CheckRecord[];
	/** The configuration for every path, or a function returning the configuration at a path. */
	readonly config: Pick<MelianConfig, "resolution" | "ruleAliases"> | ConfigFor;
	/** Names of checks whose skip still lets a review pass, such as a tool with no files in its language to check. */
	readonly allowSkip?: readonly string[];
}

/** A review's findings, the checks it accounts for, and the configuration that decides them, ready to decide. */
export class Adjudication {
	readonly findings: readonly Finding[];
	readonly manifest: Manifest;
	readonly #configFor: ConfigFor;

	constructor({ findings, manifest, checks, config, allowSkip = [] }: AdjudicationInput) {
		this.findings = findings;
		this.manifest = new Manifest(manifest, checks, allowSkip);
		this.#configFor = typeof config === "function" ? config : () => config;
	}

	/**
	 * The defects the findings report, in the input order of the finding that speaks for each. Two findings are one
	 * defect when different checks report them in the same file, on the same normalised snippet at the same occurrence,
	 * over overlapping lines, whatever their rules: two lenses that file one broken caller under `broken-caller` and
	 * `unhandled-error` describe one defect. Findings from one check stay apart, since a check that reports two rules on
	 * one line means two defects, and so do two rules that an entry of `ruleAliases` marks `distinct`.
	 *
	 * One finding speaks for each defect. `ruleAliases` in the configuration at its path decides first: a finding whose
	 * rule is a key listing another member's rule is preferred, so a repository can say the defect belongs to the
	 * contracts lens. Otherwise the most severe speaks, the lower ID on a tie, as {@link Defect.merge} merges them. A
	 * finding without a snippet is never merged.
	 *
	 * Only findings with the same lifecycle status merge. A dismissed finding never absorbs a live one: a live finding
	 * beside a dismissed report of the same defect stays live, and blocks if it blocks, listing the dismissed one in
	 * `alsoReportedAs` with `dismissed: true`.
	 */
	defects(): Defect[] {
		const groups: Finding[][] = [];
		for (const finding of [...this.findings].sort((a, b) => a.compareStrength(b))) {
			const into = groups.find(
				(group) => group[0]!.properties.status === finding.properties.status && this.#joins(group, finding),
			);
			if (into === undefined) groups.push([finding]);
			else into.push(finding);
		}
		const dismissed = this.findings.filter((finding) => finding.properties.status === "dismissed");
		const defects = new Map<Finding, Defect>();
		for (const group of groups) {
			// A live defect names the dismissed reports of it, for context, and is never absorbed by them.
			const context =
				group[0]!.properties.status === "dismissed"
					? []
					: dismissed
							.filter((other) => this.#joins(group, other))
							.map((other) => ({ ...other.report(), dismissed: true as const }));
			if (group.length === 1 && context.length === 0) {
				const [alone] = group as [Finding];
				const members = (alone.properties.alsoReportedAs ?? []).filter((member) => member.dismissed !== true);
				defects.set(alone, new Defect(alone, members));
				continue;
			}
			const keeper = this.#keeper(group);
			defects.set(keeper, Defect.merge(keeper, group, context));
		}
		return this.findings.flatMap((finding) => {
			const defect = defects.get(finding);
			return defect === undefined ? [] : [defect];
		});
	}

	/** The finding that speaks for each of {@link Adjudication.defects}, in input order. */
	dedupe(): Finding[] {
		return this.defects().map((defect) => defect.speaker);
	}

	/**
	 * Decides the review: merges findings two checks reported for one problem ({@link Adjudication.defects}), resolves
	 * each under its path's configuration ({@link Finding.resolved}), and derives the status. Every finding is resolved
	 * here, whether it arrives without a resolution, as a producer stores it, or with one, which is replaced; none is
	 * dropped or counted as `silent` for lacking one. A failed check, one its budget ended, a skipped one not allowed to
	 * skip, or a check of the manifest with no record makes the review `not-reviewed`, even with no findings. Otherwise
	 * a finding above `silent` makes it `findings`, and nothing does `passed`. A dismissed finding counts toward neither.
	 */
	adjudicate(): Verdict {
		const resolved = this.dedupe()
			.map((finding) => finding.resolved(this.#configFor(finding.properties.path, finding.ruleId)))
			.sort((a, b) => a.compareReading(b));
		const counted = resolved.filter((finding) => finding.properties.status !== "dismissed");
		const grouped = Object.fromEntries(
			resolutionOrder.map((resolution) => [
				resolution,
				counted.filter((finding) => finding.properties.resolution === resolution),
			]),
		) as Record<Resolution, ResolvedFinding[]>;
		const attention = counted.some((finding) => finding.properties.resolution !== "silent");
		return new Verdict({
			status: this.manifest.complete() ? (attention ? "findings" : "passed") : "not-reviewed",
			blocking: grouped.block.length > 0,
			findings: grouped,
			dismissed: resolved.filter((finding) => finding.properties.status === "dismissed"),
			notRun: this.manifest.notRun(),
			ran: this.manifest.ran(),
		});
	}

	// Whether `finding` reports the defect `group` holds, whatever the statuses.
	#joins(group: readonly Finding[], finding: Finding): boolean {
		const site = finding.site();
		const aliases = this.#configFor(finding.properties.path).ruleAliases;
		return (
			site !== undefined &&
			group[0]!.site() === site &&
			group.every(
				(member) =>
					member.properties.source.check !== finding.properties.source.check &&
					!distinct(aliases, member.ruleId, finding.ruleId),
			) &&
			group.some((member) => member.overlaps(finding))
		);
	}

	// The finding that speaks for a defect: one whose rule `ruleAliases` names as the owner of another member's rule,
	// else the most severe.
	#keeper(group: readonly Finding[]): Finding {
		const aliases = this.#configFor(group[0]!.properties.path).ruleAliases;
		const owners = group.filter((finding) => {
			const entry = entryOf(aliases, finding.ruleId);
			return !entry.distinct && entry.rules.some((alias) => group.some((other) => other.ruleId === alias));
		});
		return [...(owners.length > 0 ? owners : group)].sort((a, b) => a.compareStrength(b))[0]!;
	}
}
