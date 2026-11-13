// A round's verdict from the records a RecordSet resolves, through the pipeline's own readers and Adjudication. Adapted
// from issue #373's spike, verdict.ts, to the decision's envelope: unsigned records with a `revision` field.
import { Adjudication, type CheckRecord, Revision, type StoredVerdict, snippetHash } from "@melian-agent/core";
import { configsFor } from "../../packages/pipeline/src/configurations.ts";
import { FindingsDocument, readFindings, reopens, seenBefore } from "../../packages/pipeline/src/findings.ts";
import { type ConversationId, backgroundContext as context } from "../../packages/pipeline/src/harness.ts";
import type { Envelope } from "./envelope.ts";
import type { ClosingPayload, RecordSet, Status } from "./reader.ts";

type Round = ClosingPayload & {
	base: string;
	head: string;
	manifest: string[];
	allowSkip: string[];
	producers: { check: string; version?: string; ids?: string[] }[];
	config: unknown;
	policy?: never;
	verificationRan?: boolean;
	files: unknown[];
	previous: string[];
};

export type RoundVerdict = { verdict: StoredVerdict; status: Status; absent: number };

export function statusOf(verdict: StoredVerdict): Status {
	if (verdict.status === "not-reviewed") return "not-reviewed";
	return verdict.findings.block.length > 0 ? "blocking" : verdict.status === "passed" ? "passed" : "findings";
}

export async function roundVerdict(
	set: RecordSet,
	closingId: string,
	repoRoot: string,
	options: { reopen?: boolean } = {},
): Promise<RoundVerdict> {
	const closing = set.byId.get(closingId)!;
	const round = closing.payload as unknown as Round;
	const revision = closing.revision!;
	const { found: rested, absent } = set.rests(closingId);
	const dismissals = new Map<string, Envelope>();
	for (const record of set.dismissals()) dismissals.set(record.key, record);
	type Item = {
		lifecycle: Record<string, unknown>;
		sightings: Record<string, Record<string, unknown>>;
		verifications?: Record<string, Record<string, Record<string, unknown>>>;
	};
	const items: Record<string, Item> = {};
	const item = (id: string) => {
		items[id] = items[id] ?? { lifecycle: { status: "new", history: [] }, sightings: {} };
		return items[id];
	};
	for (const record of rested) {
		if (record.kind === "sighting") {
			const [id, producer] = record.key.split(" ") as [string, string];
			const { sightings } = item(id);
			sightings[record.revision!] = { ...sightings[record.revision!], [producer]: record.payload };
		} else if (record.kind === "verification") {
			const [id, producer, version] = record.key.split(" ") as [string, string, string];
			const found = item(id);
			const byRevision = found.verifications ?? {};
			const byProducer = byRevision[record.revision!] ?? {};
			byProducer[producer] = { ...byProducer[producer], [version]: record.payload };
			byRevision[record.revision!] = byProducer;
			found.verifications = byRevision;
		}
	}
	const order = [...round.previous, revision];
	for (const [id, found] of Object.entries(items)) {
		const first = order.find((at) => found.sightings[at] !== undefined) ?? revision;
		found.lifecycle = { status: "new", history: [], firstSeenRevision: first, lastSeenRevision: revision };
		const dismissal = dismissals.get(id)?.payload as Record<string, unknown> | undefined;
		const accepted = dismissal?.trigger as { hash: string; proof: { file: string; hash: string }[] } | undefined;
		const dismissedAt = (dismissal?.sighting as { revision?: string } | undefined)?.revision;
		const reopenedRevision =
			options.reopen === true && accepted !== undefined
				? order.slice(dismissedAt === undefined ? 0 : order.indexOf(dismissedAt) + 1).find((at) =>
						Object.values(found.sightings[at] ?? {}).some((sighting) => {
							const { cause, trigger } = (
								sighting as { properties: { cause: never; trigger?: { hash?: string; snippet?: string } } }
							).properties;
							return reopens(
								accepted.hash,
								accepted.proof,
								cause,
								trigger?.hash ?? snippetHash(trigger?.snippet ?? ""),
								undefined,
							);
						}),
					)
				: undefined;
		const reopened = reopenedRevision !== undefined;
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
		else if (reopened)
			found.lifecycle.history = [
				{
					dismissedBy: dismissal!.by,
					dismissedReason: dismissal!.reason,
					dismissedAt: dismissal!.at,
					reopenedRevision,
				},
			];
	}
	const inherited: Record<string, unknown> = {};
	for (const record of rested.filter((each) => each.kind === "inheritance")) inherited[record.key] = record.payload;
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
	const findings = await readFindings(reader, root, revision, context, { producers: round.producers as never });
	const carried = await seenBefore(reader, root, revision, context);
	let config: ConstructorParameters<typeof Adjudication>[0]["config"] = () => round.config as never;
	if (round.policy !== undefined) config = await configsFor(repoRoot, round.policy, findings);
	const checks = rested
		.filter((record) => record.kind === "check")
		.map((record) => record.payload as unknown as CheckRecord);
	const manifest = [...round.manifest];
	if (absent.length > 0) {
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
	})
		.adjudicate()
		.toJSON();
	return { verdict, status: statusOf(verdict), absent: absent.length };
}
