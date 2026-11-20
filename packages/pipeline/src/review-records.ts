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
	type RecordEnvelope,
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
import { DismissError } from "./errors.ts";
import type { FindingsState } from "./findings.ts";
import type { StoredBudgetEnd } from "./lens-tools.ts";
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
	// `run` is the request key the sighting's check run stamped when it was dismissed, which no payload carries.
	readonly sighting: { readonly revision: string; readonly finding: StoredFinding; readonly run?: string };
	readonly rounds: readonly string[];
	// The rounds of the changeset the writer's store held as the dismissal was made, which only `made` knows.
	readonly frontier?: readonly string[];
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
	"withheld",
	"unkeyed",
]);
const shared = (text: string): string => (codes.has(text) ? text : withheld);
// A tool's version comes from its installed manifest, which the head can write, so only a version in semver's own
// form of at most 64 characters, or Melian's `unavailable`, leaves the machine. A lens's version is Melian's own.
const toolVersion = (version: string | undefined): string | null =>
	version === undefined
		? null
		: version === "unavailable" || (version.length <= 64 && valid(version) === version)
			? version
			: withheld;
const sharedVersion = ({ check, version }: FindingSource): string | null =>
	check.startsWith("lens.") ? orNull(version) : toolVersion(version);
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
		if (result.status === "ran" && result.snapshots?.some((each) => !hashed(each))) {
			const withheld: CheckRunRecord = { name: result.name, status: "failed", reason: "withheld", error: "" };
			return this.#record("check", key, { v: 1, result: checkResult(withheld), sightings: [] });
		}
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
					source: { check: source.check, version: sharedVersion(source) },
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
	 * it follows, each read once in ID order, as core requires. Its key is a request of the revision and
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
	 * The record of the dismissal of `id`, a finding `state` holds, that `melian dismiss` wrote to the store and `held`
	 * holds, so every round shares the same bytes; `undefined` for a finding with no frozen sighting, which a dismissal
	 * stored before findings document version 11 lacks and every reopen drops. It throws `DismissError`
	 * `madeWithoutStore` when `held` holds no such record: only the writer, as it dismissed, could name the rounds its
	 * store held then.
	 */
	dismissalOf(
		state: FindingsState,
		id: string,
		held: readonly RecordEnvelope[],
		proof?: StaticProof,
	): SharedRecord | undefined {
		const facts = ReviewRecords.#dismissalFacts(state, id);
		return facts === undefined ? undefined : this.dismissal(facts, held, proof);
	}

	/** The record `held` holds of the dismissal `facts` describe, as for `dismissalOf`. */
	dismissal(facts: DismissalFacts, held: readonly RecordEnvelope[], proof?: StaticProof): SharedRecord {
		const copy = this.#heldCopy(this.#dismissalEnvelope(facts, proof), held);
		if (copy !== undefined) return copy;
		throw new DismissError(
			"madeWithoutStore",
			`The dismissal of ${facts.finding} was made with no record store, so no record names the rounds its host held then, and it is not shared.`,
			{ revision: facts.sighting.revision, finding: facts.finding },
		);
	}

	/**
	 * What tells the dismissal of `id`, a finding `state` holds, from any other: the ID of the record `held` holds of
	 * it, or for a dismissal made with no store, the ID its record would have with no frontier and no supersedes.
	 * `undefined` as for `dismissalOf`.
	 */
	dismissalIdentity(state: FindingsState, id: string, held: readonly RecordEnvelope[]): string | undefined {
		const facts = ReviewRecords.#dismissalFacts(state, id);
		if (facts === undefined) return undefined;
		const envelope = this.#dismissalEnvelope(facts);
		return this.#heldCopy(envelope, held)?.id ?? ReviewRecords.#bare(envelope);
	}

	/** The record `made` writes for the dismissal of `id` that `state` holds, or `undefined` as for `dismissalOf`. */
	madeOf(
		state: FindingsState,
		id: string,
		listing: readonly RecordEnvelope[],
		proof?: StaticProof,
	): SharedRecord | undefined {
		const facts = ReviewRecords.#dismissalFacts(state, id);
		return facts === undefined ? undefined : this.made(facts, listing, proof);
	}

	static #dismissalFacts(state: FindingsState, id: string): DismissalFacts | undefined {
		const { lifecycle } = state.items[id]!;
		const sighting = lifecycle.dismissedSighting;
		if (sighting === undefined) return undefined;
		return {
			finding: id,
			by: lifecycle.dismissedBy!,
			reason: lifecycle.dismissedReason!,
			at: lifecycle.dismissedAt!,
			severity: lifecycle.dismissedSeverity!,
			// A sighting holds no lifecycle, so it reads as new, as `dismissedRoots` reads it.
			sighting: {
				revision: sighting.revision,
				finding: { ...sighting.sighting, properties: { ...sighting.sighting.properties, status: "new" } },
				...(sighting.run === undefined ? {} : { run: sighting.run }),
			},
			rounds: [],
			trigger: lifecycle.dismissedTrigger!,
		};
	}

	/**
	 * The record of a dismissal `melian dismiss` has just made, written once, keyed by the finding's ID; it carries no
	 * revision, by rule 5, and names the head of its own sighting. `listing` holds the records the writer's store holds
	 * as the dismissal is made: the record names every round of the changeset there as its frontier, and supersedes each
	 * dismissal of its finding that stands there. The record `listing` already holds for this dismissal is returned as
	 * it is, so a dismissal made again writes nothing new.
	 */
	made(facts: DismissalFacts, listing: readonly RecordEnvelope[], proof?: StaticProof): SharedRecord {
		const frontier = listing
			.filter((each) => each.kind === "round" && each.changeset === this.changeset)
			.map((each) => SharedRecord.parseEnvelope(each).id);
		const envelope = this.#dismissalEnvelope({ ...facts, frontier }, proof);
		const copy = this.#heldCopy(envelope, listing);
		if (copy !== undefined) return copy;
		const own = SharedRecord.parse(envelope, reviewPayloads).id;
		// Only a record in the same slot supersedes, as `RecordSet` rules, so an edge from any other is no replacement.
		const slot = listing.filter(
			(each) => each.kind === "dismissal" && each.changeset === this.changeset && each.key === facts.finding,
		);
		const replaced = new Set(slot.flatMap((each) => each.supersedes ?? []));
		const standing = slot.flatMap((each) => {
			const { id } = SharedRecord.parseEnvelope(each);
			return id === own || replaced.has(id) ? [] : [id];
		});
		if (standing.length === 0) return SharedRecord.parse(envelope, reviewPayloads);
		return SharedRecord.parse({ ...envelope, supersedes: [...new Set(standing)].sort() }, reviewPayloads);
	}

	// A record in `held` that is this dismissal, whatever its writer's listing let it supersede or name as its frontier.
	#heldCopy(envelope: RecordEnvelope, held: readonly RecordEnvelope[]): SharedRecord | undefined {
		const own = ReviewRecords.#bare(envelope);
		const copy = held.find(
			(each) =>
				each.kind === "dismissal" &&
				each.changeset === this.changeset &&
				each.key === envelope.key &&
				ReviewRecords.#bare(each) === own,
		);
		return copy === undefined ? undefined : SharedRecord.parse(copy, reviewPayloads);
	}

	// The ID of a dismissal record with no `supersedes` and no frontier: what two records of one dismissal share.
	static #bare(envelope: RecordEnvelope): string {
		const { supersedes: _, payload, ...rest } = envelope;
		const { frontier: __, ...kept } = payload as { frontier?: unknown };
		return SharedRecord.parseEnvelope({ ...rest, payload: kept as RecordJson }).id;
	}

	// A static finding's dismissal is shared only when `proof` shows the run its sighting was stamped with stored none of
	// its tool's text.
	#dismissalEnvelope(facts: DismissalFacts, proof?: StaticProof): RecordEnvelope {
		const { id, source } = facts.sighting.finding.properties;
		// A reader refuses a set holding such a record, so writing one would cost every round that reads it.
		if (id !== facts.finding) throw new Error(`a dismissal of ${facts.finding} holds a sighting of ${id}`);
		const { check } = source;
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
			head: Revision.parseKey(facts.sighting.revision)!.head,
			rounds: [...new Set(facts.rounds)].sort(),
			...(facts.frontier === undefined ? {} : { frontier: [...new Set(facts.frontier)].sort() }),
			trigger: { hash: facts.trigger.hash, proof: facts.trigger.proof.map(({ file, hash }) => ({ file, hash })) },
		};
		return {
			v: 1,
			changeset: this.changeset,
			kind: "dismissal",
			key: facts.finding,
			payload: payload as unknown as RecordJson,
		};
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

// Melian checks only these three fields of Enola's receipt; the rest is Enola's text.
function receipt(text: string): string {
	let parsed: { format_version?: unknown; snapshot_id?: unknown; enola_version?: unknown };
	try {
		parsed = JSON.parse(text);
	} catch {
		return withheld;
	}
	const { format_version, snapshot_id, enola_version } = parsed ?? {};
	if (
		format_version !== 1 ||
		typeof snapshot_id !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(snapshot_id) ||
		typeof enola_version !== "string" ||
		!/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(enola_version)
	)
		return withheld;
	return JSON.stringify({ format_version, snapshot_id, enola_version });
}

// Melian computes each of a snapshot's identities as a SHA-256 hash, so anything else in one is text it did not write.
function hashed({ snapshotId, cacheKey, coverage }: EnolaSnapshot): boolean {
	const ids = [cacheKey, coverage?.graph, coverage?.review, coverage?.test].filter((id) => id !== undefined);
	return /^sha256:[a-f0-9]{64}$/.test(snapshotId) && ids.every((id) => /^[a-f0-9]{64}$/.test(id));
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
