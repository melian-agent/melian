import {
	type AccountPayload,
	type CheckErrorCode,
	type CheckPayload,
	type CheckRecord,
	canonicalJson,
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
import { valid } from "semver";
import { blindCallers, lightTriage } from "./caveats.ts";
import type { CheckRunRecord } from "./checks.ts";
import type { StoredBudgetEnd } from "./lens-tools.ts";

type DecidedCheck = NonNullable<LensPayload["check"]>;

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
	// The verifier's check as the review decided it, or none while its run has not ended.
	readonly check?: CheckRecord;
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

/** What an exported record says in place of text a tool, a provider or the head's code may have written. */
export const withheld = "Melian shares none of this text, which the reviewing host's store and terminal hold";

// The codes a record may carry as they are: a check error's, a task outcome's, and the account's own.
const codes: ReadonlySet<string> = new Set([
	...([
		"unknownCheck",
		"unknownTier",
		"tierCycle",
		"unknownConversation",
		"notCompleted",
		"noEnvironment",
		"worktreeFailed",
		"toolMissing",
		"toolFailed",
		"timeout",
		"aborted",
		"nothingToCheck",
		"outputTooLarge",
		"invalidOutput",
		"unreadable",
		"tooLarge",
	] satisfies CheckErrorCode[]),
	"failed",
	"orphaned",
	"faulted",
	"no record",
	"unexpected",
]);
const shared = (text: string): string => (codes.has(text) ? text : withheld);
// A tool's version comes from its installed manifest, which the head can write, so only a version in semver's own
// form, or Melian's `unavailable`, leaves the machine.
const toolVersion = (version: string | undefined): string | null =>
	version === undefined ? null : version === "unavailable" || valid(version) === version ? version : withheld;
const caveat = (text: string): string =>
	text.startsWith(blindCallers) ? blindCallers : text === lightTriage ? text : withheld;
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
	check(request: string | null, result: CheckRunRecord, sightings: readonly StoredFinding[]): SharedRecord {
		const key = KeyedRequest.of("check.record", { request, base: this.base, head: this.head, name: result.name }).key;
		return this.#record("check", key, { v: 1, result: checkResult(result), sightings: sorted(sightings) });
	}

	/**
	 * A lens run's record, keyed by its request's key, with the findings it reported at this revision and, once the review
	 * has decided it, the check the run stands for.
	 */
	lens(
		run: LensRunIdentity,
		outcome: LensRunOutcome,
		sightings: readonly StoredFinding[],
		check?: CheckRecord,
	): SharedRecord {
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
			check: check === undefined ? null : (decided(check) as DecidedCheck),
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
			outcomes: [...facts.outcomes]
				.sort((a, b) => compare(a.candidate, b.candidate))
				.map(({ candidate, outcome }) => ({
					candidate,
					outcome: "reason" in outcome ? { ...outcome, reason: shared(outcome.reason) } : outcome,
				})),
			check: facts.check === undefined ? null : (decided(facts.check) as DecidedCheck),
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
			failure: entry.failure === undefined ? null : shared(entry.failure),
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
	 * How a round accounts for its tier: the tier's checks, the check and lens records it counts, the record it made for
	 * each check no record holds, the skips it allows, and the producers whose findings count. Its key is a request of
	 * the revision and the IDs of the records it counts, so the round that names it names what it counted.
	 */
	account(facts: {
		readonly checks: readonly string[];
		readonly records: readonly SharedRecord[];
		readonly filled: readonly (CheckRecord & { readonly status: "skipped" | "failed" })[];
		readonly allowSkip: readonly string[];
		readonly producers: readonly (FindingSource & { readonly ids?: readonly string[] })[];
	}): SharedRecord {
		const records = [...new Set(facts.records.map((record) => record.id))].sort(compare);
		const producers = [
			...new Map(
				facts.producers.map((producer) => {
					const version = orNull(producer.version);
					const ids = producer.ids === undefined ? null : [...new Set(producer.ids)].sort(compare);
					return [`${producer.check}@${version ?? ""}`, { check: producer.check, version, ids }] as const;
				}),
			).values(),
		].sort(
			(a, b) =>
				compare(a.check, b.check) || compare(`${a.check}@${a.version ?? ""}`, `${b.check}@${b.version ?? ""}`),
		);
		const payload: AccountPayload = {
			v: 1,
			checks: [...new Set(facts.checks)],
			records,
			// Two records alike in every field fill one entry, since an account names each once.
			filled: [
				...new Map(
					facts.filled.map((record) => {
						const entry = { ...decided(record), status: record.status };
						return [canonicalJson(entry), entry] as const;
					}),
				),
			]
				.sort(([a, x], [b, y]) => compare(x.name, y.name) || compare(a, b))
				.map(([, entry]) => entry),
			allowSkip: [...new Set(facts.allowSkip)].sort(compare),
			producers,
		};
		const key = KeyedRequest.of("account", { revision: this.revision, records }).key;
		return this.#record("account", key, payload);
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

/**
 * `records` in one order a round's records can rebuild: by the check's place in the tier's `checks`, then by name for a
 * check the tier does not name, then by the record's canonical form. The host's verdict and a reader of the round's
 * records order checks alike, so both write the same verdict.
 */
export function inManifestOrder(checks: readonly string[], records: readonly CheckRecord[]): CheckRecord[] {
	const at = (name: string) => {
		const index = checks.indexOf(name);
		return index < 0 ? checks.length : index;
	};
	return [...records].sort(
		(a, b) => at(a.name) - at(b.name) || compare(a.name, b.name) || compare(sortedJson(a), sortedJson(b)),
	);
}

// A record's JSON with its keys sorted and `undefined` and `null` fields left out, so a stored record and the one it was
// written from compare alike. Unlike `canonicalJson`, it never throws on the free text a record holds.
function sortedJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
	if (typeof value === "object" && value !== null)
		return `{${Object.keys(value)
			.filter((key) => (value as Record<string, unknown>)[key] != null)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
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
				version: toolVersion(result.version),
				findings: result.findings,
				notes: [],
				snapshots: result.snapshots === undefined ? null : (result.snapshots.map(snapshot) as never),
			};
		case "provisional":
			return {
				name: result.name,
				status: "provisional",
				version: toolVersion(result.version),
				findings: result.findings,
				notes: [],
				reason: shared(result.reason),
			};
		case "skipped":
			return { name: result.name, status: "skipped", reason: shared(result.reason), cause: orNull(result.cause) };
		case "failed":
			return {
				name: result.name,
				status: "failed",
				reason: codes.has(result.reason) ? result.reason : "unexpected",
				error: withheld,
			};
	}
}

function decided(record: CheckRecord): Omit<DecidedCheck, "status"> & { status: CheckRecord["status"] } {
	const { lineage, coverage, budgetEnded } = record;
	return {
		name: record.name,
		status: record.status,
		reason: record.reason === undefined ? null : shared(record.reason),
		error: record.error === undefined ? null : shared(record.error),
		version: orNull(record.version),
		level: orNull(record.level),
		budgetEnded:
			budgetEnded === undefined
				? null
				: {
						budget: budgetEnded.budget,
						limit: budgetEnded.limit,
						tokens: budgetEnded.tokens,
						tools: budgetEnded.tools,
					},
		caveats: record.caveats === undefined ? null : record.caveats.map(caveat),
		coverage:
			coverage === undefined
				? null
				: { graph: orNull(coverage.graph), review: orNull(coverage.review), test: orNull(coverage.test) },
		lineage:
			lineage === undefined
				? null
				: {
						model: lineage.model,
						thinking: lineage.thinking === undefined ? null : { ...lineage.thinking },
						wanted: orNull(lineage.wanted),
						by: lineage.by,
						moved: lineage.moved === undefined ? null : { ...lineage.moved },
						outside: lineage.outside,
					},
	};
}

function lensOutcome(outcome: LensRunOutcome): LensPayload["outcome"] {
	if (outcome.status === "unanswered") return { status: "unanswered", reason: shared(outcome.reason) };
	if (outcome.status === "exhausted")
		return { status: "exhausted", tried: [...outcome.tried], reason: shared(outcome.reason) };
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
