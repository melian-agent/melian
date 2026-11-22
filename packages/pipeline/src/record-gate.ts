import {
	type AccountPayload,
	Changeset,
	type CheckRecord,
	git,
	type LegacyAccountPayload,
	type MelianConfig,
	type RecordEnvelope,
	RecordError,
	RecordSet,
	type RepositorySource,
	type Resolution,
	type ResolvedFinding,
	Revision,
	reviewPayloads,
	type SharedRecord,
	type TierAccount,
	Verdict,
} from "@melian-agent/core";
import { type EndedDismissal, RecordedRound, type UnjudgedDismissal } from "./recorded-round.ts";
import { roundFacts } from "./review-records.ts";

/** A round of another revision of the head that holds a finding live, which no dismissal at the merge's revision answers. */
export type HeldElsewhere = { readonly round: string; readonly revision: string };

/** A dismissal the gate asks for again, and the round of another revision that holds its finding live, if one does. */
export type AskedAgain<T> = T & { readonly heldBy?: HeldElsewhere };

/** What the merge gate judges a head against, all read from the base tip, never from the records. */
export type RecordGateContext = {
	/** The checkout git answers ancestry and diffs in. */
	readonly repoRoot: string;
	/** The base tip the head would merge into, G. */
	readonly target: string;
	/** The merge's own diff, from merge-base(G, H) to the head H. */
	readonly revision: Revision;
	/** The base tip's configuration and the source it was read from, which every round's findings are decided under. */
	readonly config: MelianConfig;
	readonly policy: RepositorySource;
	/** The checks the base tip's tier requires of the merge's diff. */
	readonly tier: TierAccount;
	/** Whose records count, as `RecordSet.of` requires. */
	readonly counts: (record: SharedRecord) => boolean;
};

/** One round the gate counted, and the checks it covers for the merge, or why it covers none. */
export type GateRound = {
	readonly id: string;
	/** The revision the round reviewed. */
	readonly revision: string;
	readonly covers: readonly string[] | { readonly refused: string };
	/** Whether the host would read the round as reviewed, its verifier having run, so its verifier's verdicts stand. */
	readonly sound: boolean;
};

// One counted round's verdict, and whether it reviewed the merge's own revision.
type Pooled = { verdict: Verdict; own: boolean; round: string; revision: string };

const strictness: readonly Resolution[] = ["block", "acknowledge", "advisory", "silent"];

/**
 * The merge gate's answer for one head against one base tip, from a changeset's shared records alone. It counts every
 * round at the head whose base the base tip holds, and its findings decided under the base tip's policy: every finding
 * of a round of the merge's own diff, and of any other round only those on the merge's diff, so a round that reads not reviewed still hands its findings over. A finding is dismissed only
 * when every counted round that sighted it holds a dismissal of it. Coverage comes only from a round of exactly the
 * merge's diff whose records stand as reviewed under the base tip's policy and tier, and whose verifier ran when its
 * account names one, and a lens only when it ran at least at the floor the base tip sets for it. A required check no such round ran leaves the gate not reviewed. A malformed record, a round that names a record the set lacks, and a counted round
 * whose records cannot stand for it each leave the gate not reviewed.
 */
export class RecordGate {
	/** The merged verdict: the findings that count and those dismissed, with each failure and gap as a check not run. */
	readonly verdict: Verdict;
	/** The rounds counted, in record ID order. */
	readonly rounds: readonly GateRound[];
	/** Each dismissal a counted round reads as ended by a round at another revision. */
	readonly ended: readonly AskedAgain<EndedDismissal>[];
	/** Each dismissal a counted round cannot judge, since a round of its changeset names what the store does not hold. */
	readonly unjudged: readonly AskedAgain<UnjudgedDismissal>[];
	/** Why the records cannot decide the gate, each naming the record or round. */
	readonly failures: readonly string[];

	private constructor(fields: {
		verdict: Verdict;
		rounds: GateRound[];
		ended: AskedAgain<EndedDismissal>[];
		unjudged: AskedAgain<UnjudgedDismissal>[];
		failures: string[];
	}) {
		this.verdict = fields.verdict;
		this.rounds = fields.rounds;
		this.ended = fields.ended;
		this.unjudged = fields.unjudged;
		this.failures = fields.failures;
	}

	/** The gate over `records` of `changeset` under `context`. Git answers each round's ancestry and diff. */
	static async decide(
		records: readonly RecordEnvelope[],
		changeset: string,
		context: RecordGateContext,
	): Promise<RecordGate> {
		let set: RecordSet;
		try {
			set = RecordSet.of(records, { counts: context.counts, payloads: reviewPayloads });
		} catch (error) {
			if (!(error instanceof RecordError)) throw error;
			return RecordGate.#failed([`a record fails its checks: ${error.message}`]);
		}
		const { revision, repoRoot } = context;
		const failures: string[] = [];
		const counted: SharedRecord[] = [];
		for (const round of set.records()) {
			if (round.kind !== "round" || round.changeset !== changeset) continue;
			const sides = Revision.parseKey(round.revision ?? "");
			if (sides === undefined || sides.head !== revision.head) continue;
			const holds = await ancestor(repoRoot, sides.base, context.target);
			if (holds === undefined)
				failures.push(
					`git cannot tell whether round ${round.id}'s base ${sides.base} is in the base tip's history`,
				);
			else if (holds) counted.push(round);
		}
		for (const round of counted) {
			const missing = set.missing(round);
			if (missing.length > 0)
				failures.push(
					`round ${round.id} names records the store does not hold: ${missing.map(({ id }) => id).join(", ")}`,
				);
		}
		if (failures.length > 0) return RecordGate.#failed(failures);
		const gate = Revision.key(revision);
		const rounds: GateRound[] = [];
		const ended: EndedDismissal[] = [];
		const unjudged: UnjudgedDismissal[] = [];
		const verdicts: Pooled[] = [];
		const covered = new Set<string>();
		// Why a round of the merge that ran a check still leaves it uncovered, by the check's name, the first round's.
		const short = new Map<string, string>();
		for (const round of counted) {
			const read = RecordedRound.of(records, round.id, context.counts);
			const sides = Revision.parseKey(round.revision!)!;
			const own = (await Changeset.resolve(repoRoot, { base: sides.base, head: sides.head, mode: "twoDot" }))
				.revision;
			const under = { revision: own, config: context.config, repoRoot, policy: context.policy };
			const judged = await coverage(set, round, read, under, context.tier);
			const sound = !("refused" in judged) || judged.sound;
			const covers =
				round.revision !== gate
					? { refused: `reviewed ${round.revision}, not this merge's ${gate}`, sound }
					: judged;
			// A round that is not sound lowers nothing: its findings count as no verifier judged them, uncapped. Any
			// round's finding no verifier judged counts uncapped, since the cap was safe only while its round read as not
			// reviewed.
			const findings = await read.findingsUnder(under, { verifier: sound ? "uncapped" : "ignored" });
			if ("refused" in findings) {
				failures.push(`round ${round.id} ${findings.refused}`);
				continue;
			}
			verdicts.push({ verdict: findings, own: round.revision === gate, round: round.id, revision: round.revision! });
			const contents = read.contents(own);
			if (!("refused" in contents)) {
				ended.push(...contents.ended);
				unjudged.push(...contents.unjudged);
			}
			const explain = (check: string, why: string) => {
				if (!short.has(check)) short.set(check, `round ${round.id}${why}`);
			};
			if ("refused" in covers)
				for (const check of covers.would ?? [])
					explain(check, " would cover it, but did not run its verifier, so it covers nothing");
			else {
				for (const check of covers.covers) covered.add(check);
				for (const { name: check, level } of covers.below)
					explain(
						check,
						` ran it ${level === undefined ? "with no level" : `at ${level}`}, below the floor of ${context.tier.floor(check.slice("lens.".length))} the base tip sets for it now, so a new round must run it at that floor`,
					);
			}
			rounds.push({
				id: round.id,
				revision: round.revision!,
				covers: "refused" in covers ? { refused: covers.refused } : covers.covers,
				sound,
			});
		}
		if (counted.length === 0) failures.push(`no round reviewed head ${revision.head} at a base the base tip holds`);
		const gaps: CheckRecord[] = context.tier.checks
			.filter((name) => !covered.has(name))
			.map((name) => ({
				name,
				status: "skipped",
				reason: short.get(name) ?? `no round of ${gate} that stands as reviewed ran it`,
			}));
		const { verdict, heldBy } = RecordGate.#merged(verdicts, revision.paths(), [...failures.map(asFailure), ...gaps]);
		// Only a finding the gate holds live needs dismissing again, and two rounds can read one dismissal as ended alike.
		const live = new Set(
			Object.values(verdict.findings).flatMap((found) => found.map(({ properties }) => properties.id)),
		);
		const once = <T extends { finding: string }>(entries: readonly T[]): AskedAgain<T>[] => [
			...new Map(
				entries
					.filter(({ finding }) => live.has(finding))
					.map((each) => {
						const held = heldBy.get(each.finding);
						return [JSON.stringify(each), held === undefined ? each : { ...each, heldBy: held }];
					}),
			).values(),
		];
		return new RecordGate({ verdict, rounds, ended: once(ended), unjudged: once(unjudged), failures });
	}

	static #failed(failures: string[]): RecordGate {
		return new RecordGate({
			verdict: RecordGate.#merged([], [], failures.map(asFailure)).verdict,
			rounds: [],
			ended: [],
			unjudged: [],
			failures,
		});
	}

	/** Whether the head may merge: every required check is covered, and no finding blocks or awaits an answer. */
	passes(): boolean {
		const { verdict } = this;
		return (
			verdict.status !== "not-reviewed" && verdict.findings.block.length + verdict.findings.acknowledge.length === 0
		);
	}

	// One verdict of every round's findings: a finding counts at its strictest resolution in any round, and is dismissed
	// only when no round holds it live and some round dismissed it. A round of another revision, such as a stacked
	// parent's, hands over only its findings on `paths`; the merge's own round hands over every finding. `heldBy` names,
	// for each finding a round of another revision holds live, the first such round.
	static #merged(
		verdicts: readonly Pooled[],
		paths: readonly string[],
		notRun: CheckRecord[],
	): { verdict: Verdict; heldBy: Map<string, HeldElsewhere> } {
		const onDiff = new Set(paths);
		const proves = ({ properties: { path, trigger } }: ResolvedFinding) =>
			[
				path,
				...(trigger === undefined ? [] : [trigger.file, ...(trigger.proof ?? []).map(({ file }) => file)]),
			].some((file) => onDiff.has(file));
		const live = new Map<string, ResolvedFinding>();
		const dismissed = new Map<string, ResolvedFinding>();
		const heldBy = new Map<string, HeldElsewhere>();
		for (const { verdict, own, round, revision } of verdicts) {
			const counts = (finding: ResolvedFinding) => own || proves(finding);
			for (const finding of Object.values(verdict.findings).flat().filter(counts)) {
				const held = live.get(finding.id);
				if (held === undefined || RecordGate.#stricter(finding, held)) live.set(finding.id, finding);
				if (!own && !heldBy.has(finding.id)) heldBy.set(finding.id, { round, revision });
			}
			for (const finding of verdict.dismissed.filter(counts))
				if (!dismissed.has(finding.id)) dismissed.set(finding.id, finding);
		}
		for (const id of live.keys()) dismissed.delete(id);
		const findings = Object.fromEntries(
			strictness.map((resolution) => [
				resolution,
				[...live.values()]
					.filter((finding) => finding.properties.resolution === resolution)
					.sort(RecordGate.#byPlace),
			]),
		) as Record<Resolution, ResolvedFinding[]>;
		const attention = findings.block.length + findings.acknowledge.length + findings.advisory.length;
		const verdict = new Verdict({
			status: notRun.length > 0 ? "not-reviewed" : attention > 0 ? "findings" : "passed",
			blocking: findings.block.length > 0,
			findings,
			dismissed: [...dismissed.values()].sort(RecordGate.#byPlace),
			notRun,
		});
		return { verdict, heldBy };
	}

	static #stricter(finding: ResolvedFinding, than: ResolvedFinding): boolean {
		const rank = strictness.indexOf(finding.properties.resolution) - strictness.indexOf(than.properties.resolution);
		return rank < 0 || (rank === 0 && finding.properties.severity < than.properties.severity);
	}

	static #byPlace(left: ResolvedFinding, right: ResolvedFinding): number {
		const [leftLine] = left.lines();
		const [rightLine] = right.lines();
		return (
			(left.properties.path < right.properties.path ? -1 : left.properties.path > right.properties.path ? 1 : 0) ||
			leftLine - rightLine ||
			(left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
		);
	}
}

// Whether `commit` is in `tip`'s history, or `undefined` when git cannot say, such as for a commit the clone lacks.
async function ancestor(repoRoot: string, commit: string, tip: string): Promise<boolean | undefined> {
	const { code } = await git(repoRoot, ["merge-base", "--is-ancestor", commit, tip]);
	return code === 0 ? true : code === 1 ? false : undefined;
}

// The checks `round` covers for a merge of its own diff: those that ran, and those skipped with the tier's leave, when
// its records stand as reviewed under the base tip's policy and account for its tier, with each lens that ran below the
// base tip's floor; otherwise why they cannot, with the checks it would cover when only its verifier did not run.
async function coverage(
	set: RecordSet,
	round: SharedRecord,
	read: RecordedRound,
	under: Parameters<RecordedRound["reviewed"]>[0],
	tier: TierAccount,
): Promise<
	| { readonly covers: readonly string[]; readonly below: readonly CheckRecord[] }
	| { readonly refused: string; readonly sound: boolean; readonly would?: readonly string[] }
> {
	const manifest = round.manifest()!;
	if (manifest.replaces.length > 0) return { refused: `replaces ${manifest.replaces.join(", ")}`, sound: false };
	const byId = new Map(set.records().map((record) => [record.id, record]));
	const elsewhere = manifest.read.find(({ id }) => byId.get(id)?.revision !== round.revision);
	if (elsewhere !== undefined) return { refused: `names record ${elsewhere.id} of another revision`, sound: false };
	const account = set.account(round);
	if (account === undefined) return { refused: "names no account, or more than one", sound: false };
	const claim = account.payload as AccountPayload | LegacyAccountPayload;
	const facts = roundFacts(
		claim.records.flatMap((id) => byId.get(id) ?? []),
		claim,
	);
	const reviewed = await read.reviewed(under);
	// The host caps a finding its failed verifier never judged at advisory, and reads the round as not reviewed.
	const verified =
		!("refused" in reviewed) &&
		(!claim.checks.includes("verifier") || (reviewed.ran ?? []).some(({ name }) => name === "verifier"));
	const refusal = tier.refusal(claim, facts);
	if (refusal !== undefined)
		return { refused: `does not account for the base tip's tier (${refusal})`, sound: verified };
	if ("refused" in reviewed) return { ...reviewed, sound: false };
	// A lens's level is the one the check in its standing record holds, which the round's host wrote.
	const atFloor = ({ name, level }: CheckRecord) =>
		!name.startsWith("lens.") || tier.meetsFloor(name.slice("lens.".length), level);
	const leave = new Set(tier.allowSkip(facts));
	const covers = [
		...(reviewed.ran ?? []).filter(atFloor).map(({ name }) => name),
		...reviewed.notRun.filter(({ status, name }) => status === "skipped" && leave.has(name)).map(({ name }) => name),
	];
	if (!verified)
		return {
			refused: "did not run its verifier, so not every finding it raised was judged",
			sound: false,
			would: covers,
		};
	return { covers, below: (reviewed.ran ?? []).filter((check) => !atFloor(check)) };
}

function asFailure(reason: string): CheckRecord {
	return { name: "records", status: "failed", reason };
}
