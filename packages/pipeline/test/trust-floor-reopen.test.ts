import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, defaultConfig, Finding } from "@melian-agent/core";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type JsonObject,
	openHarness,
	openSqliteStorage,
	readFindings,
	readVerdict,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { FindingsDocument } from "../src/findings.ts";
import { PublishedDocument } from "../src/publish.ts";

const recorded = JSON.parse(
	readFileSync(new URL("./fixtures/step29-previous/review.json", import.meta.url), "utf8"),
) as {
	findings: JsonObject;
	verdicts: JsonObject;
	published: JsonObject;
};

it("reopens the previous documents unchanged, then persists a newly decided trust floor", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-trust-floor-reopen-")));
	const path = join(directory, "state.sqlite");
	const fake = createFakeModels();
	const open = async () =>
		openHarness(await openSqliteStorage(path), { models: fake.models, registry: createRegistry() });
	const harnesses = [];
	try {
		const first = await open();
		harnesses.push(first);
		const root = await first.root(context);
		await root.commit(async (tx) => {
			for (const [kind, version, history, value] of [
				["melian.findings", 8, "rewindable", recorded.findings],
				["melian.verdicts", 9, "rewindable", recorded.verdicts],
				["melian.published", 7, "latest", recorded.published],
			] as const) {
				const definition = { kind, version, initial: () => ({}) };
				const token =
					history === "latest"
						? defineDoc<JsonObject>({ ...definition, scope: "conversation", history: "latest", fork: "current" })
						: defineDoc<JsonObject>({
								...definition,
								scope: "conversation",
								history: "rewindable",
								fork: "asOf",
							});
				Object.assign(await tx.doc(token, root.id), value);
			}
		}, context);
		await first.close(context);
		const second = await open();
		harnesses.push(second);
		expect(await second.snapshot(FindingsDocument, root.id, context)).toEqual(recorded.findings);
		expect(await second.snapshot(VerdictDocument, root.id, context)).toEqual(recorded.verdicts);
		expect(await second.snapshot(PublishedDocument, root.id, context)).toEqual(recorded.published);
		const previous = (await readVerdict(second, root.id, "base..head", context))!;
		expect(previous.findings.advisory).toHaveLength(1);
		expect(previous.findings.advisory[0]?.properties.decidedBy?.trustFloor).toBeUndefined();
		const findings = await readFindings(second, root.id, "base..head", context);
		const verdict = new Adjudication({ findings, config: defaultConfig, manifest: [], checks: [] }).adjudicate();
		expect(verdict.findings.acknowledge[0]?.properties.decidedBy?.trustFloor).toMatchObject([
			{ severity: "P2", action: "lowered", minimum: "acknowledge" },
		]);
		const reopenedRoot = await second.root(context);
		await reopenedRoot.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).verdicts["base..head"] = verdict.toJSON();
		}, context);
		await second.close(context);
		const third = await open();
		harnesses.push(third);
		const persisted = (await readVerdict(third, root.id, "base..head", context))!;
		expect(persisted.toJSON()).toEqual(verdict.toJSON());
		expect(Finding.parse(persisted.findings.acknowledge[0]).properties.decidedBy?.trustFloor).toHaveLength(1);
	} finally {
		for (const harness of harnesses) await harness.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});
