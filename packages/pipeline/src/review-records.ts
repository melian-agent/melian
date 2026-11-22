import {
	type AccountPayload,
	type CheckPayload,
	type CheckRecord,
	canonicalJson,
	type DismissalPayload,
	type EnolaSnapshot,
	Finding,
	type FindingSource,
	hashPattern,
	isReceipt,
	isToolVersion,
	KeyedRequest,
	type LensPayload,
	type NamedRecord,
	objectIdPattern,
	type RecordJson,
	Revision,
	type RunStage,
	recordCodes,
	recordLimit,
	reviewPayloads,
	type ScrutinyLevel,
	type Severity,
	SharedRecord,
	SightingBudget,
	type StoredDecision,
	type StoredFinding,
	type StoredRunDetails,
	snapshotIdPattern,
	type TelemetryPayload,
	type TriagePayload,
	telemetryOutcomes,
	type Verification,
	type VerificationPayload,
	type Walkthrough,
	type WalkthroughPayload,
	withheld,
} from "@melian-agent/core";
import { blindCallers, lightTriage } from "./caveats.ts";
import type { CheckRunRecord } from "./checks.ts";
import { DismissError } from "./errors.ts";
import type { StoredBudgetEnd } from "./lens-tools.ts";
import { relayLimits } from "./record-relay.ts";
import type { StaticProof } from "./static-proof.ts";

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

type Outcome = VerificationPayload["outcomes"][number]["outcome"];
/** A candidate's outcome as the verifier ended it, its reason not yet withheld. */
export type VerificationOutcome = Outcome extends infer Each
	? Each extends { reason: unknown }
		? Omit<Each, "reason"> & { reason: string }
		: Each
	: never;

/** A verification's claims, the dismissals its verifier was shown, and each candidate's outcome, as its record holds them. */
export type VerificationFacts = {
	readonly claims: readonly { id: string; source: FindingSource; verification: Verification }[];
	readonly dismissals: readonly { finding: string; record: string }[];
	readonly outcomes: readonly { candidate: string; outcome: VerificationOutcome }[];
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
	// `run` is the request key the sighting's check run stamped when it was dismissed, which no payload carries.
	readonly sighting: { readonly revision: string; readonly finding: StoredFinding; readonly run?: string };
	readonly rounds: readonly string[];
	readonly trigger: { readonly hash: string; readonly proof: readonly { file: string; hash: string }[] };
};

const micros = (dollars: number): number => Math.round(dollars * 1_000_000);
const orNull = <T>(value: T | undefined): T | null => value ?? null;

export { withheld };

/** Why a round is not recorded when one of its records passes the store's limit, which names no record's text. */
export const recordTooLarge =
	"A record of the round passes the store's 4 MiB limit even with its findings' detail left out, so Melian records no round.";

const codes: ReadonlySet<string> = new Set(recordCodes);
const outcomes: ReadonlySet<string> = new Set(telemetryOutcomes);
const shared = <T extends string>(text: string): T => (codes.has(text) ? text : withheld) as T;
// A tool's version comes from its installed manifest, which the head can write, so only one core's `isToolVersion`
// takes leaves the machine. A lens's version and the verifier's are Melian's own.
const toolVersion = (version: string | undefined): string | null =>
	version === undefined ? null : isToolVersion(version) ? version : withheld;
const sharedVersion = ({ check, version }: FindingSource): string | null =>
	check.startsWith("lens.") || check === "verifier" ? orNull(version) : toolVersion(version);
const hashed = new RegExp(hashPattern);
const coverageId = (id: string | undefined): string | null => (id !== undefined && hashed.test(id) ? id : null);
const caveat = (text: string): typeof blindCallers | typeof lightTriage | typeof withheld =>
	text.startsWith(blindCallers) ? blindCallers : text === lightTriage ? lightTriage : withheld;
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
		return this.fittedCheck(request, result, sightings).record;
	}

	/**
	 * A check's record, as {@link ReviewRecords.check} builds it, and whether it left out the detail of some of its
	 * shared sightings to fit the store's limit. The trim measures the projected sightings, which are what the record
	 * holds, in the room the record leaves beside them, so local findings stay whole.
	 *
	 * @throws {RecordError} `recordTooLarge` when the record passes the limit even with every finding's detail left out.
	 */
	fittedCheck(
		request: string | null,
		result: CheckRunRecord,
		sightings: readonly StoredFinding[],
	): { record: SharedRecord; trimmed: boolean } {
		const key = KeyedRequest.of("check.record", { request, base: this.base, head: this.head, name: result.name }).key;
		if (result.status === "ran" && result.snapshots?.some((each) => !minted(each))) {
			const withheld: CheckRunRecord = { name: result.name, status: "failed", reason: "withheld", error: "" };
			return {
				record: this.#record("check", key, { v: 1, result: checkResult(withheld), sightings: [] }),
				trimmed: false,
			};
		}
		const projected = sorted(sightings);
		// A canonical array of n items takes 2 + (n - 1) bytes beside them, which the budget counts, so the room is the
		// limit less the record with an empty array, `[]`, plus those 2.
		const bare = this.#record("check", key, { v: 1, result: checkResult(result), sightings: [] });
		const room = new SightingBudget(recordLimit - Buffer.byteLength(bare.bytes) + 2);
		const findings = projected.map((each) => Finding.from(each as unknown as StoredFinding));
		const fitted = room.fit(findings);
		const shared = fitted.map((each) => each.toJSON() as unknown as RecordJson);
		return {
			record: this.#record("check", key, { v: 1, result: checkResult(result), sightings: shared }),
			trimmed: fitted.some((each, index) => each !== findings[index]),
		};
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
					source: { check: source.check, version: sharedVersion(source) },
					verification,
				})),
			dismissals: [...facts.dismissals].sort((a, b) => compare(a.finding, b.finding)),
			outcomes: [...facts.outcomes]
				.sort((a, b) => compare(a.candidate, b.candidate))
				.map(({ candidate, outcome }) => ({
					candidate,
					outcome: ("reason" in outcome ? { ...outcome, reason: shared(outcome.reason) } : outcome) as Outcome,
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
	 * each check no record holds, the skips it allows, the producers whose findings count, and the fingerprint of the
	 * resolution policy it decided under. Its key is a request of the revision, the IDs of the records it counts and that
	 * fingerprint, so the round that names it names what it counted and the policy it counted under.
	 */
	account(facts: {
		readonly checks: readonly string[];
		readonly records: readonly SharedRecord[];
		readonly filled: readonly (CheckRecord & { readonly status: "skipped" | "failed" })[];
		readonly allowSkip: readonly string[];
		readonly producers: readonly (FindingSource & { readonly ids?: readonly string[] })[];
		readonly resolutionPolicy: string | null;
	}): SharedRecord {
		const records = [...new Set(facts.records.map((record) => record.id))].sort(compare);
		// Two versions withheld alike name one producer, whose findings are both producers' findings.
		const united = new Map<string, { check: string; version: string | null; ids: string[] | null }>();
		for (const producer of facts.producers) {
			const version = sharedVersion(producer);
			const key = `${producer.check}@${version ?? ""}`;
			const earlier = united.get(key);
			const ids =
				producer.ids === undefined || earlier?.ids === null
					? null
					: [...new Set([...(earlier?.ids ?? []), ...producer.ids])].sort(compare);
			united.set(key, { check: producer.check, version, ids });
		}
		const producers = [...united.values()].sort(
			(a, b) =>
				compare(a.check, b.check) || compare(`${a.check}@${a.version ?? ""}`, `${b.check}@${b.version ?? ""}`),
		);
		const payload: AccountPayload = {
			v: 2,
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
			resolutionPolicy: facts.resolutionPolicy,
		};
		const key = accountKey(this.revision, payload);
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

	/**
	 * The records a round exports: `read`, and the round that names them. A walkthrough joins only a round that still
	 * fits with it, since the relay takes none, so one that does not fit leaves the round as it was measured without it.
	 */
	batch(
		read: readonly SharedRecord[],
		walkthrough: SharedRecord | undefined,
		before: readonly string[],
	): SharedRecord[] {
		const shown =
			walkthrough === undefined ? undefined : [...read, walkthrough, this.round(read, walkthrough, [], before)];
		return shown !== undefined && this.unrecordable(shown) === undefined
			? shown
			: [...read, this.round(read, undefined, [], before)];
	}

	/**
	 * Why a round of `made` cannot be recorded, or `undefined` when each record fits the store and all of them fit one
	 * relay batch. Each is measured by its canonical bytes, which every store writes and the relay sums.
	 */
	unrecordable(made: readonly SharedRecord[]): string | undefined {
		const sizes = made.map((record) => Buffer.byteLength(record.bytes));
		if (sizes.some((size) => size > recordLimit)) return recordTooLarge;
		const total = sizes.reduce((sum, size) => sum + size, 0);
		if (total > relayLimits.bytes)
			return `The round's records come to ${total} bytes, past the relay's 8 MiB batch of ${relayLimits.bytes} bytes, so Melian records no round.`;
		return undefined;
	}

	/**
	 * A dismissal's record, keyed by the finding's ID; it carries no revision, by rule 5. A static finding's is shared
	 * only when `proof` shows the run its sighting was stamped with stored none of its tool's text.
	 */
	dismissal(facts: DismissalFacts, proof?: StaticProof): SharedRecord {
		const { check } = facts.sighting.finding.properties.source;
		if (check.startsWith("static.") && proof?.asks(check, facts.sighting.run) !== true)
			throw new DismissError(
				"unprovenRun",
				`The dismissed ${check} finding carries no proof that the run which sighted it stored none of its tool's text, so its dismissal is not shared.`,
				{ revision: facts.sighting.revision, finding: facts.finding },
			);
		const payload: DismissalPayload = {
			v: 1,
			by: facts.by,
			reason: facts.reason,
			at: facts.at,
			severity: facts.severity,
			sighting: {
				revision: facts.sighting.revision,
				finding: shareable(sighting(facts.sighting.finding)) as unknown as RecordJson,
			},
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
 * An account's key: a request of its revision, the IDs of the records it counts, and the fingerprint of the policy it
 * decided under. The rest of its payload follows from those records and that policy.
 */
export function accountKey(
	revision: string | null,
	{ records, resolutionPolicy }: Pick<AccountPayload, "records" | "resolutionPolicy">,
): string {
	return KeyedRequest.of("account", { revision, records, resolutionPolicy }).key;
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
	return [...sightings].map((finding) => shareable(sighting(finding))).sort(byId) as unknown as RecordJson[];
}

// A static finding keeps its rule, place, snippet and trigger, which are the head's own, and none of its tool's text. Biome
// and tsc are rewritten too: a build from before issue #281 stored their text, and the label cannot say which build wrote it.
function sighting(finding: StoredFinding): StoredFinding {
	const { check } = finding.properties.source;
	if (!check.startsWith("static.")) return finding;
	const what = `${check} reports ${finding.ruleId} here. ${withheld}.`;
	return {
		...finding,
		message: { ...finding.message, text: what },
		properties: { ...finding.properties, explanation: { what, whyHere: withheld, whatToDo: withheld } },
	};
}

// Melian checks only these three fields of Enola's receipt, in the form core's schema takes; the rest is Enola's text.
function receipt(text: string): string {
	let parsed: { format_version?: unknown; snapshot_id?: unknown; enola_version?: unknown };
	try {
		parsed = JSON.parse(text);
	} catch {
		return withheld;
	}
	const { format_version, snapshot_id, enola_version } = parsed ?? {};
	const kept = JSON.stringify({ format_version, snapshot_id, enola_version });
	return isReceipt(kept) ? kept : withheld;
}

// Melian computes each of a snapshot's identities as a SHA-256 hash, and its commit is a git object ID, so anything else
// in one is text Melian did not write.
function minted({ commit, snapshotId, cacheKey, coverage }: EnolaSnapshot): boolean {
	const ids = [cacheKey, coverage?.graph, coverage?.review, coverage?.test].filter((id) => id !== undefined);
	return (
		new RegExp(objectIdPattern).test(commit) &&
		new RegExp(snapshotIdPattern).test(snapshotId) &&
		ids.every((id) => hashed.test(id))
	);
}

function shareable(finding: StoredFinding): StoredFinding {
	const { source } = finding.properties;
	const version = sharedVersion(source);
	return version === orNull(source.version)
		? finding
		: {
				...finding,
				properties: { ...finding.properties, source: { check: source.check, version: version ?? undefined } },
			};
}

function snapshot(each: EnolaSnapshot): RecordJson {
	return {
		commit: each.commit,
		snapshotId: each.snapshotId,
		receipt: receipt(each.receipt),
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
				reason: codes.has(result.reason) ? (result.reason as (typeof recordCodes)[number]) : "unexpected",
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
		version: sharedVersion({ check: record.name, version: record.version }),
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
				: {
						graph: coverageId(coverage.graph),
						review: coverageId(coverage.review),
						test: coverageId(coverage.test),
					},
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
		outcome: outcomes.has(each.outcome) ? (each.outcome as (typeof telemetryOutcomes)[number]) : withheld,
		tools: orNull(each.tools),
		limits:
			each.limits === undefined ? null : { tokens: orNull(each.limits.tokens), tools: orNull(each.limits.tools) },
		ended: orNull(each.ended),
		usageIncomplete: each.usageIncomplete === true,
	};
}
