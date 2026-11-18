import { type Changeset, KeyedRequest, Revision } from "@melian-agent/core";
import { type CheckRun, type CheckRunRecord, backgroundContext as context, type Harness } from "@melian-agent/pipeline";
import { ChecksDocument } from "../../src/checks.ts";
import { replaceCheckFindings } from "../../src/findings.ts";

const current = { guardrails: 1, "static.biome": 3, "static.tsc": 4, "static.enola": 3, "static.mutation": 3 };
// A run's request always keys the checkout's install; an identified one lets no second run share the key.
const install = { digests: { "package-lock.json": "a".repeat(64) }, identified: true };

// What a run's terminal commits leave for `records` at the changeset's revision, with no sightings: the request kept
// under its key, and each static check stamped with it. A review handed the returned run proves its static checks.
export async function provenRun(
	harness: Harness,
	changeset: Changeset,
	records: readonly CheckRunRecord[],
	tier = "full",
): Promise<CheckRun> {
	const asked = KeyedRequest.of("check", { checks: current, install });
	const root = await harness.root(context);
	const revision = Revision.key(changeset.revision);
	await root.commit(async (tx) => {
		const runs = await tx.doc(ChecksDocument, root.id);
		runs.requests = { ...runs.requests, [asked.key]: asked.request };
		for (const { name } of records)
			if (name.startsWith("static.")) await replaceCheckFindings(tx, root.id, name, revision, [], asked.key);
	}, context);
	const { base, head } = changeset.revision;
	return { identity: { base, head, tier, policy: asked.key.slice(0, 16), task: 1 }, request: asked.key, records };
}
