// Issue #379's copy of spikes/record-373/verdict.ts, changed in two places only: the reopen rule takes each revision's
// proving hunks, as the decision's section 9 says the verdict reads the diff, and trust is a predicate rather than a key
// map, since section 6 counts an unsigned record that is in the store.
// Computes a round's verdict from records alone. No Pi storage is opened: the pipeline's pure readers run over a plain
// object rebuilt from the records, behind a reader whose snapshot returns it. Only a round that names a policy source
// reads anything else, the policy files at the base commit, through git.

import type { ProvingHunk } from "@melian-agent/core";
import {
	Adjudication,
	type CheckRecord,
	type RepositorySource,
	Revision,
	type StoredVerdict,
	snippetHash,
} from "@melian-agent/core";
import { configsFor } from "../../packages/pipeline/src/configurations.ts";
import { FindingsDocument, readFindings, reopens, seenBefore } from "../../packages/pipeline/src/findings.ts";
import { type ConversationId, backgroundContext as context } from "../../packages/pipeline/src/harness.ts";
import { type RecordEnvelope, recordId } from "../record-373/record.ts";

type Round = {
	base: string;
	head: string;
	manifest: string[];
	allowSkip: string[];
	producers: { check: string; version?: string; ids?: string[] }[];
	config: unknown;
	policy?: RepositorySource;
	resolutionPolicy?: string;
	verificationRan?: boolean;
	files: unknown[];
	previous: string[];
	rests: { kind: string; key: string; id: string }[];
};

export type Computed = {
	verdict: StoredVerdict;
	round: string;
	absent: { kind: string; key: string; id: string }[];
	// Records outside the round that changed what it rests on, by kind, such as a later dismissal.
	added: string[];
	// What the computation read that no record held.
	outside: string[];
};

// Among trusted records under one kind and key, the lowest record ID wins.
function lowest(records: readonly RecordEnvelope[]): RecordEnvelope | undefined {
	return [...records].sort((a, b) => (recordId(a) < recordId(b) ? -1 : 1))[0];
}

export async function computeVerdict(
	records: readonly RecordEnvelope[],
	accept: (record: RecordEnvelope) => boolean,
	revision: string,
	repoRoot: string,
	// Apply the lifecycle's reopen rule to a dismissal record at this revision's sightings. The record is immutable and
	// outlives the code it accepted, so without the rule a dismissal stands after its trigger changes.
	options: { reopen?: boolean; hunks?: (revision: string) => readonly ProvingHunk[] } = {},
): Promise<Computed | undefined> {
	const trusted = records.filter(accept);
	const byId = new Map(trusted.map((record) => [recordId(record), record]));
	const closing = lowest(trusted.filter((record) => record.kind === "round" && record.key === revision));
	if (closing === undefined) return undefined;
	const round = closing.payload as unknown as Round;
	const absent = round.rests.filter((rest) => !byId.has(rest.id));
	const rested = round.rests.flatMap((rest) => (byId.has(rest.id) ? [byId.get(rest.id)!] : []));
	// A dismissal may arrive after the round, from another signer; every other kind counts only as the round names it.
	const named = new Set(round.rests.map((rest) => rest.id));
	const later = trusted.filter((record) => record.kind === "dismissal" && !named.has(recordId(record)));
	const dismissals = new Map<string, RecordEnvelope>();
	for (const record of [...rested.filter((each) => each.kind === "dismissal"), ...later]) {
		const winner = lowest([record, ...(dismissals.has(record.key) ? [dismissals.get(record.key)!] : [])])!;
		dismissals.set(record.key, winner);
	}
	const items: Record<
		string,
		{
			lifecycle: Record<string, unknown>;
			sightings: Record<string, Record<string, unknown>>;
			verifications?: Record<string, Record<string, Record<string, unknown>>>;
		}
	> = {};
	const item = (id: string) => {
		items[id] = items[id] ?? { lifecycle: { status: "new", history: [] }, sightings: {} };
		return items[id];
	};
	for (const record of rested) {
		if (record.kind === "sighting") {
			const [at, id, producer] = record.key.split(" ") as [string, string, string];
			const { sightings } = item(id);
			sightings[at] = { ...sightings[at], [producer]: record.payload };
		} else if (record.kind === "verification") {
			const [at, id, producer, version] = record.key.split(" ") as [string, string, string, string];
			const found = item(id);
			const byRevision = found.verifications ?? {};
			const byProducer = byRevision[at] ?? {};
			byProducer[producer] = { ...byProducer[producer], [version]: record.payload };
			byRevision[at] = byProducer;
			found.verifications = byRevision;
		}
	}
	const outside: string[] = [];
	const order = [...round.previous, revision];
	for (const [id, found] of Object.entries(items)) {
		const first = order.find((at) => found.sightings[at] !== undefined) ?? revision;
		found.lifecycle = { status: "new", history: [], firstSeenRevision: first, lastSeenRevision: revision };
		const dismissal = dismissals.get(id)?.payload as Record<string, unknown> | undefined;
		const accepted = dismissal?.trigger as { hash: string; proof: { file: string; hash: string }[] } | undefined;
		// An introduced finding's rule compares trigger hashes and needs no diff; an affected one's proof needs a
		// revision's hunks, which no record holds. The first revision after the dismissal's own whose sightings break the
		// trigger reopens it, and the dismissal moves to history, as the lifecycle does.
		const dismissedAt = (dismissal?.sighting as { revision?: string } | undefined)?.revision;
		const reopenedRevision =
			options.reopen === true && accepted !== undefined
				? order.slice(dismissedAt === undefined ? 0 : order.indexOf(dismissedAt) + 1).find((at) =>
						Object.values(found.sightings[at] ?? {}).some((sighting) => {
							const { cause, trigger } = (
								sighting as { properties: { cause: never; trigger?: { hash?: string; snippet?: string } } }
							).properties;
							if (accepted.proof.length > 0 && cause !== "introduced")
								outside.push(`the hunks of ${at}, to test ${id}'s proof`);
							return reopens(
								accepted.hash,
								accepted.proof,
								cause,
								trigger?.hash ?? snippetHash(trigger?.snippet ?? ""),
								options.hunks?.(at),
							);
						}),
					)
				: undefined;
		const reopened = reopenedRevision !== undefined;
		if (reopened)
			found.lifecycle.history = [
				{
					dismissedBy: dismissal!.by,
					dismissedReason: dismissal!.reason,
					dismissedAt: dismissal!.at,
					reopenedRevision,
				},
			];
		if (dismissal !== undefined && !reopened)
			found.lifecycle = {
				...found.lifecycle,
				status: "dismissed",
				dismissedBy: dismissal.by,
				dismissedReason: dismissal.reason,
				dismissedAt: dismissal.at,
				...(dismissal.severity === undefined ? {} : { dismissedSeverity: dismissal.severity }),
				...(dismissal.sighting === undefined ? {} : { dismissedSighting: dismissal.sighting }),
				...(dismissal.trigger === undefined ? {} : { dismissedTrigger: dismissal.trigger }),
			};
	}
	const inherited: Record<string, unknown> = {};
	for (const record of rested.filter((each) => each.kind === "inheritance"))
		inherited[record.key.split(" ")[1]!] = record.payload;
	const state = {
		revisions: order,
		items,
		versions: {},
		...(Object.keys(inherited).length === 0 ? {} : { inherited: { [revision]: inherited } }),
	};
	const reader = {
		snapshot: async (document: unknown) => {
			if (document !== FindingsDocument) throw new Error("the computation reads the findings and nothing else");
			return structuredClone(state);
		},
	} as unknown as Parameters<typeof readFindings>[0];
	const root = 0 as unknown as ConversationId;
	const findings = await readFindings(reader, root, revision, context, { producers: round.producers });
	const carried = await seenBefore(reader, root, revision, context);
	let config: ConstructorParameters<typeof Adjudication>[0]["config"] = () => round.config as never;
	if (round.policy !== undefined) {
		outside.push(`policy at ${round.policy.kind === "revision" ? round.policy.commit : round.policy.kind}`);
		config = await configsFor(repoRoot, round.policy, findings);
	}
	const checks = rested
		.filter((record) => record.kind === "check")
		.map((record) => record.payload as unknown as CheckRecord);
	const manifest = [...round.manifest];
	if (absent.length > 0) {
		// The round names a record no host can find, so the round reads as not reviewed.
		manifest.push("record");
		checks.push({ name: "record", status: "failed", reason: `the round names ${absent.length} record(s) not found` });
	}
	const verdict = new Adjudication({
		findings,
		manifest,
		checks,
		config,
		allowSkip: round.allowSkip,
		verificationRan: round.verificationRan,
		seenBefore: carried,
		revision: Revision.from({ base: round.base, head: round.head, files: round.files as never }),
	}).adjudicate();
	return {
		verdict: verdict.toJSON(),
		round: recordId(closing),
		absent,
		added: later.filter((record) => dismissals.get(record.key) === record).map((record) => record.kind),
		outside,
	};
}
