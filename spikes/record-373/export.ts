// A minimal exporter: reads one decided round from a changeset's Pi storage and writes it as signed records. This is
// the only spike module that opens Pi storage; `verdict.ts` reads nothing but the records it writes.
import type { StoredVerdict } from "@melian-agent/core";
import type { AdjudicationTaskInput } from "../../packages/pipeline/src/adjudication.ts";
import { VerdictDocument } from "../../packages/pipeline/src/adjudication.ts";
import { FindingsDocument } from "../../packages/pipeline/src/findings.ts";
import { backgroundContext as context, type Harness, type TaskId } from "../../packages/pipeline/src/harness.ts";
import { ReviewIndex } from "../../packages/pipeline/src/review-index.ts";
import type { Json, RecordDirectory, Signer } from "./record.ts";

export type Exported = { round: string; stored: StoredVerdict; records: number };

const producerKey = (source: { check: string; version?: string }) => `${source.check}@${source.version ?? ""}`;

export async function exportRound(
	harness: Harness,
	changeset: string,
	revision: string,
	signer: Signer,
	into: RecordDirectory,
): Promise<Exported> {
	const root = (await harness.root(context)).id;
	const entry = (await harness.snapshot(ReviewIndex, root, context))?.reviews[revision];
	if (entry?.adjudication === undefined) throw new Error(`no adjudication is indexed for ${revision}`);
	const task = await harness.getTask(entry.adjudication.task as TaskId, context);
	const input = task!.input as unknown as AdjudicationTaskInput;
	const findings = (await harness.snapshot(FindingsDocument, root, context))!;
	const stored = (await harness.snapshot(VerdictDocument, root, context))!.verdicts[revision]!;
	const rests: { kind: string; key: string; id: string }[] = [];
	const add = (kind: string, key: string, payload: unknown) => {
		const record = signer.sign({ v: 1, changeset, kind, key, payload: structuredClone(payload) as Json });
		rests.push({ kind, key, id: into.add(record) });
	};
	const previous = findings.revisions.slice(0, findings.revisions.indexOf(revision));
	for (const [id, item] of Object.entries(findings.items)) {
		for (const [at, byProducer] of Object.entries(item.sightings)) {
			if (at !== revision && !previous.includes(at)) continue;
			for (const [producer, sighting] of Object.entries(byProducer))
				add("sighting", `${at} ${id} ${producer}`, sighting);
		}
		for (const [producer, byVersion] of Object.entries(item.verifications?.[revision] ?? {}))
			for (const [version, verification] of Object.entries(byVersion))
				add("verification", `${revision} ${id} ${producer} ${version}`, verification);
		const { lifecycle } = item;
		if (lifecycle.status === "dismissed")
			add("dismissal", id, {
				by: lifecycle.dismissedBy!,
				reason: lifecycle.dismissedReason!,
				at: lifecycle.dismissedAt!,
				...(lifecycle.dismissedSeverity === undefined ? {} : { severity: lifecycle.dismissedSeverity }),
				...(lifecycle.dismissedSighting === undefined ? {} : { sighting: lifecycle.dismissedSighting }),
				...(lifecycle.dismissedTrigger === undefined ? {} : { trigger: lifecycle.dismissedTrigger }),
			});
	}
	for (const [id, link] of Object.entries(findings.inherited?.[revision] ?? {}))
		add("inheritance", `${revision} ${id}`, link);
	for (const check of input.checks) add("check", `${revision} ${check.name}`, check);
	// The round's closing record names every record it rests on, and is written last.
	add("round", revision, {
		base: input.base,
		head: input.head,
		manifest: input.manifest,
		allowSkip: input.allowSkip,
		producers: input.producers,
		config: input.config,
		...(input.policy === undefined ? {} : { policy: input.policy }),
		...(input.resolutionPolicy === undefined ? {} : { resolutionPolicy: input.resolutionPolicy }),
		...(input.verificationRan === undefined ? {} : { verificationRan: input.verificationRan }),
		files: input.files ?? [],
		previous,
		rests: [...rests],
	});
	return { round: rests.at(-1)!.id, stored, records: rests.length };
}

export { producerKey };
