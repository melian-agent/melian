import { type Changeset, KeyedRequest, Revision } from "@melian-agent/core";
import { type CheckRun, type CheckRunRecord, backgroundContext as context, type Harness } from "@melian-agent/pipeline";
import { CheckSources, ChecksDocument, identityKey } from "../../src/checks.ts";
import { replaceCheckFindings } from "../../src/findings.ts";

const current = { guardrails: 1, "static.biome": 3, "static.tsc": 4, "static.enola": 5, "static.mutation": 3 };
// A run's request always keys the checkout's install; an identified one lets no second run share the key.
const install = { digests: { "package-lock.json": "a".repeat(64) }, identified: true };

// What a run's terminal commits leave for `records` at the changeset's revision, with no sightings: the request kept
// under its key, the records under the run, and each static check stamped with the key and the check task the run's
// task recorded for it. A review
// handed the returned run proves its static checks.
export async function provenRun(
	harness: Harness,
	changeset: Changeset,
	records: readonly CheckRunRecord[],
	tier = "full",
): Promise<CheckRun> {
	const asked = KeyedRequest.of("check", { checks: current, install });
	const root = await harness.root(context);
	const revision = Revision.key(changeset.revision);
	const { base, head } = changeset.revision;
	const identity = { base, head, tier, policy: asked.key.slice(0, 16), task: 1 };
	await root.commit(async (tx) => {
		const runs = await tx.doc(ChecksDocument, root.id);
		runs.requests = { ...runs.requests, [asked.key]: asked.request };
		runs.runs[identityKey(identity)] = Object.fromEntries(records.map((record) => [record.name, record]));
		// The run's task, 1, records the check task it started for each static check, which stamps what that task wrote.
		const sources = await tx.doc(CheckSources, root.id, "1", null);
		for (const [index, { name }] of records.entries()) {
			if (!name.startsWith("static.")) continue;
			sources.tasks[name] = 2 + index;
			await replaceCheckFindings(tx, root.id, name, revision, [], { request: asked.key, task: 2 + index });
		}
	}, context);
	return { identity, request: asked.key, records };
}
