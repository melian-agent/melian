import { Adjudication, defaultConfig, Revision } from "@melian-agent/core";
import { CompareHarness, backgroundContext as context, createMemoryStorage } from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { ReviewIndex } from "../src/review-index.ts";

const revision = { base: "a".repeat(40), head: "b".repeat(40) };
const key = Revision.key(revision);

const open: CompareHarness[] = [];

afterEach(async () => {
	for (const harness of open.splice(0)) await harness.close(context);
});

// A decided legacy round of `revision`, which names no task, so no adjudication in the index can belong to it.
async function decided(): Promise<CompareHarness> {
	const harness = await CompareHarness.open(createMemoryStorage(), createFakeModels().review, "change");
	open.push(harness);
	const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig }).adjudicate();
	const root = await harness.harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(VerdictDocument, root.id)).verdicts = { [key]: verdict.toJSON() };
	}, context);
	return harness;
}

describe("CompareHarness ownedRun", () => {
	it("selects no round and owns no run of an unattributed comparison", async () => {
		const harness = await decided();
		const unattributed = { ...revision, round: "unattributed" };

		expect(await harness.round(unattributed)).toBeUndefined();
		expect(await harness.ownedRun(unattributed)).toBeUndefined();
	});

	it("owns no run of a round when the review index holds no review of its revision", async () => {
		const harness = await decided();
		expect((await harness.round(revision))?.stored.tasks).toEqual([]);

		expect(await harness.ownedRun(revision)).toBeUndefined();
	});

	it("owns no run of a round when its revision's review has no adjudication yet", async () => {
		const harness = await decided();
		const root = await harness.harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(ReviewIndex, root.id)).reviews[key] = { lenses: [] };
		}, context);

		expect(await harness.ownedRun(revision)).toBeUndefined();
	});
});
