import {
	type CheckPayload,
	type DismissalPayload,
	type EnolaSnapshot,
	type FindingSource,
	KeyedRequest,
	type LensPayload,
	type NamedRecord,
	type RecordJson,
	Revision,
	type RunStage,
	reviewPayloads,
	type ScrutinyLevel,
	type Severity,
	SharedRecord,
	type StoredDecision,
	type StoredFinding,
	type StoredRunDetails,
	type TelemetryPayload,
	type TriagePayload,
	type Verification,
	type VerificationPayload,
	type Walkthrough,
	type WalkthroughPayload,
} from "@melian-agent/core";
import type { CheckRunRecord } from "./checks.ts";
import type { StoredBudgetEnd } from "./lens-tools.ts";

// A lens run's outcome as the lens task stores it, with the fields a record keeps.
export type LensRunOutcome =
	| {
			readonly status: "done";
			readonly model?: string;
			readonly budgetEnded?: StoredBudgetEnd;
			readonly capped?: number;
			readonly escalation?: {
				readonly trigger: { kind: "severity"; severity: Severity } | { kind: "budget"; budget: "tokens" | "tools" };
				readonly to?: string;
				readonly carried?: readonly string[];
				readonly kept?: readonly string[];
				readonly refuted?: readonly string[];
			};
			readonly usage?: { models: string[]; tokens: number; cost: number };
	  }
	| { readonly status: "unanswered"; readonly reason: string }
	| { readonly status: "exhausted"; readonly tried: readonly string[]; readonly reason: string };

/** One lens run as its record names it: the lens, its version and level, its request's key, and whether it probes. */
export type LensRunIdentity = {
	readonly name: string;
	readonly version: string;
	readonly level: ScrutinyLevel;
	readonly request: string;
	readonly probe: boolean;
};

/** A verification's claims, the dismissals its verifier was shown, and each candidate's outcome, as its record holds them. */
export type VerificationFacts = {
	readonly claims: readonly { id: string; source: FindingSource; verification: Verification }[];
	readonly dismissals: readonly { finding: string; record: string }[];
	readonly outcomes: VerificationPayload["outcomes"];
};

/** A dismissal as the findings document's lifecycle keeps it, with what a dismissal record needs present. */
export type DismissalFacts = {
	readonly finding: string;
	readonly by: string;
	readonly reason: string;
	readonly at: string;
	readonly severity: Severity;
	readonly sighting: { readonly revision: string; readonly finding: StoredFinding };
	readonly rounds: readonly string[];
	readonly trigger: { readonly hash: string; readonly proof: readonly { file: string; hash: string }[] };
};

const micros = (dollars: number): number => Math.round(dollars * 1_000_000);
const orNull = <T>(value: T | undefined): T | null => value ?? null;
const byId = (a: StoredFinding, b: StoredFinding): number =>
	a.properties.id < b.properties.id ? -1 : a.properties.id > b.properties.id ? 1 : 0;

/**
 * The records one review writes at one revision of one changeset, each checked by its kind's payload check as it is
 * built, so Melian never adds a record its own reader would refuse. Every value is written one way: a field the stored
 * shape leaves out is `null`, and findings are in ID order, so building a record twice gives the same bytes.
 */
export class ReviewRecords {
	readonly changeset: string;
	readonly revision: string;
	readonly base: string;
	readonly head: string;

	private constructor(changeset: string, base: string, head: string) {
		this.changeset = changeset;
		this.base = base;
		this.head = head;
		this.revision = Revision.key({ base, head });
	}

	/** The records of `changeset` at the revision from `base` to `head`, each a full object ID. */
	static of(changeset: string, sides: { readonly base: string; readonly head: string }): ReviewRecords {
		return new ReviewRecords(changeset, sides.base, sides.head);
	}

	/**
	 * A check's record, keyed by the check run's full request key, this revision and the check's name: one tier run
	 * writes one record per check, and two revisions never share one.
	 */
	check(run: string, result: CheckRunRecord, sightings: readonly StoredFinding[]): SharedRecord {
		const key = KeyedRequest.of("check", { run, base: this.base, head: this.head, name: result.name }).key;
		return this.#record("check", key, { v: 1, result: checkResult(result), sightings: sorted(sightings) });
	}

	/** A lens run's record, keyed by its request's key, with the findings it reported at this revision. */
	lens(run: LensRunIdentity, outcome: LensRunOutcome, sightings: readonly StoredFinding[]): SharedRecord {
		const payload: LensPayload = {
			v: 1,
			name: run.name,
			version: run.version,
			level: run.level,
			probe: run.probe,
			outcome: lensOutcome(outcome),
			sightings: sorted(sightings),
			// Delivery evidence waits on the coverage ledger, which works it out from the transcript.
			delivery: null,
		};
		return this.#record("lens", run.request, payload);
	}

	/** A verification's record, keyed by its request's key. */
	verification(key: string, facts: VerificationFacts): SharedRecord {
		const payload: VerificationPayload = {
			v: 1,
			claims: [...facts.claims]
				.sort((a, b) => compare(claimOrder(a), claimOrder(b)))
				.map(({ id, source, verification }) => ({
					id,
					source: { check: source.check, version: source.version ?? null },
					verification,
				})),
			dismissals: [...facts.dismissals].sort((a, b) => compare(a.finding, b.finding)),
			outcomes: [...facts.outcomes].sort((a, b) => compare(a.candidate, b.candidate)),
		};
		return this.#record("verification", key, payload);
	}

	/** A walkthrough's record, keyed by its request's key, with the route that wrote it. */
	walkthrough(key: string, route: string, walkthrough: Walkthrough): SharedRecord {
		const payload: WalkthroughPayload = {
			v: 1,
			route,
			summary: walkthrough.summary,
			files: walkthrough.files.map(({ path, summary }) => ({ path, summary })),
			diagram: orNull(walkthrough.diagram),
			note: orNull(walkthrough.note),
		};
		return this.#record("walkthrough", key, payload);
	}

	/** A triage record, keyed by its request's key: the decision, or why there is none, and whether the input was cut. */
	triage(
		key: string,
		entry: { readonly decision?: StoredDecision; readonly failure?: string; readonly inputCut?: boolean },
	): SharedRecord {
		const decision = entry.decision;
		const payload: TriagePayload = {
			v: 1,
			decision:
				decision === undefined
					? null
					: {
							questionSet: { name: decision.questionSet.name, version: decision.questionSet.version },
							decider: decision.decider,
							calibrated: decision.calibrated,
							model: orNull(decision.model),
							answers: decision.answers.map(({ question, distribution, chosen }) => ({
								question,
								distribution: Object.fromEntries(
									Object.entries(distribution).map(([option, weight]) => [option, micros(weight)]),
								),
								chosen,
							})),
						},
			failure: orNull(entry.failure),
			inputCut: entry.inputCut === true,
		};
		return this.#record("triage", key, payload);
	}

	/** A round's telemetry, keyed by the round record's ID, so a round names its telemetry and never the reverse. */
	telemetry(round: SharedRecord, details: StoredRunDetails): SharedRecord {
		const payload: TelemetryPayload = {
			v: 1,
			durationMs: orNull(details.durationMs),
			stages: details.stages.map(stage),
		};
		return this.#record("telemetry", round.id, payload);
	}

	/**
	 * A round's record: every record it read, its walkthrough, the rounds of this revision it replaces, and the rounds
	 * of the revision before, each read once in ID order, as core requires. Its key is a request of the revision and
	 * the IDs it read, so a round that read the same records is the same record.
	 */
	round(
		read: readonly SharedRecord[],
		walkthrough: SharedRecord | undefined,
		replaces: readonly string[],
		before: readonly string[],
	): SharedRecord {
		const byId = new Map(read.map(({ kind, key, id }) => [id, { kind, key, id }]));
		const named: NamedRecord[] = [...byId.values()].sort((a, b) => compare(a.id, b.id));
		const manifest = {
			read: named,
			walkthrough: walkthrough === undefined ? null : { key: walkthrough.key, id: walkthrough.id },
			replaces: [...new Set(replaces)].sort(),
			before: [...new Set(before)].sort(),
		};
		const key = KeyedRequest.of("round", { revision: this.revision, read: named.map((each) => each.id) }).key;
		return this.#record("round", key, manifest);
	}

	/** A dismissal's record, keyed by the finding's ID; it carries no revision, by rule 5. */
	dismissal(facts: DismissalFacts): SharedRecord {
		const payload: DismissalPayload = {
			v: 1,
			by: facts.by,
			reason: facts.reason,
			at: facts.at,
			severity: facts.severity,
			sighting: { revision: facts.sighting.revision, finding: facts.sighting.finding as unknown as RecordJson },
			head: this.head,
			rounds: [...new Set(facts.rounds)].sort(),
			trigger: { hash: facts.trigger.hash, proof: facts.trigger.proof.map(({ file, hash }) => ({ file, hash })) },
		};
		return SharedRecord.parse(
			{ v: 1, changeset: this.changeset, kind: "dismissal", key: facts.finding, payload },
			reviewPayloads,
		);
	}

	#record(kind: string, key: string, payload: unknown): SharedRecord {
		return SharedRecord.parse(
			{ v: 1, changeset: this.changeset, revision: this.revision, kind, key, payload },
			reviewPayloads,
		);
	}
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function claimOrder(claim: { id: string; source: FindingSource }): string {
	return JSON.stringify([claim.id, claim.source.check, claim.source.version ?? null]);
}

function sorted(sightings: readonly StoredFinding[]): RecordJson[] {
	return [...sightings].sort(byId) as unknown as RecordJson[];
}

function snapshot(each: EnolaSnapshot): RecordJson {
	return {
		commit: each.commit,
		snapshotId: each.snapshotId,
		receipt: each.receipt,
		cacheKey: orNull(each.cacheKey),
		coverage:
			each.coverage === undefined
				? null
				: {
						graph: orNull(each.coverage.graph),
						review: orNull(each.coverage.review),
						test: orNull(each.coverage.test),
					},
	};
}

function checkResult(result: CheckRunRecord): CheckPayload["result"] {
	switch (result.status) {
		case "ran":
			return {
				name: result.name,
				status: "ran",
				version: orNull(result.version),
				findings: result.findings,
				notes: [...result.notes],
				snapshots: result.snapshots === undefined ? null : (result.snapshots.map(snapshot) as never),
			};
		case "provisional":
			return {
				name: result.name,
				status: "provisional",
				version: orNull(result.version),
				findings: result.findings,
				notes: [...result.notes],
				reason: result.reason,
			};
		case "skipped":
			return { name: result.name, status: "skipped", reason: result.reason, cause: orNull(result.cause) };
		case "failed":
			return { name: result.name, status: "failed", reason: result.reason, error: result.error };
	}
}

function lensOutcome(outcome: LensRunOutcome): LensPayload["outcome"] {
	if (outcome.status === "unanswered") return { status: "unanswered", reason: outcome.reason };
	if (outcome.status === "exhausted")
		return { status: "exhausted", tried: [...outcome.tried], reason: outcome.reason };
	const { budgetEnded, escalation, usage } = outcome;
	return {
		status: "done",
		model: orNull(outcome.model),
		budgetEnded:
			budgetEnded === undefined
				? null
				: {
						budget: budgetEnded.budget,
						limit: budgetEnded.limit,
						tokens: budgetEnded.tokens,
						tools: budgetEnded.tools,
					},
		capped: orNull(outcome.capped),
		escalation:
			escalation === undefined
				? null
				: {
						trigger: escalation.trigger,
						to: orNull(escalation.to),
						carried: [...(escalation.carried ?? [])],
						kept: [...(escalation.kept ?? [])],
						refuted: [...(escalation.refuted ?? [])],
					},
		usage:
			usage === undefined
				? null
				: { models: [...usage.models], tokens: usage.tokens, costMicros: micros(usage.cost) },
	};
}

function stage(each: RunStage): TelemetryPayload["stages"][number] {
	return {
		name: each.name,
		level: (each.level ?? null) as TelemetryPayload["stages"][number]["level"],
		models: [...each.models],
		durationMs: orNull(each.durationMs),
		tokens: orNull(each.tokens),
		cacheRead: orNull(each.cacheRead),
		costMicros: each.cost === undefined ? null : micros(each.cost),
		outcome: each.outcome,
		tools: orNull(each.tools),
		limits:
			each.limits === undefined ? null : { tokens: orNull(each.limits.tokens), tools: orNull(each.limits.tools) },
		ended: orNull(each.ended),
		usageIncomplete: each.usageIncomplete === true,
	};
}
