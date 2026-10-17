import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, defaultConfig, Finding, snippetHash } from "@melian-agent/core";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type JsonObject,
	openHarness,
	openSqliteStorage,
	readFindings,
	readVerdict,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { FindingsDocument, upsertVerification } from "../src/findings.ts";
import { PublishedDocument } from "../src/publish.ts";
import main from "./fixtures/stored-v9/findings.json" with { type: "json" };

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

it("takes the next findings version after main's accepted-trigger version", () => {
	expect(FindingsDocument.definition.version).toBe(10);
});

it.each([
	{ version: 8, findings: recorded.findings },
	{ version: 9, findings: main.findings },
])("keeps version $version findings without an evidence conversion", ({ version, findings }) => {
	expect(FindingsDocument.definition.migrate!(findings, version)).toBe(findings);
});

it.each(["introduced", "affected"] as const)(
	"reopens main's version 9 %s dismissal and retains its accepted content and verification",
	async (cause) => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-main-v9-reopen-")));
		const path = join(directory, "state.sqlite");
		const fake = createFakeModels();
		const open = async () =>
			openHarness(await openSqliteStorage(path), {
				models: fake.models,
				registry: createRegistry(),
			});
		const harnesses = [];
		try {
			const first = await open();
			harnesses.push(first);
			const root = await first.root(context);
			const old = defineDoc({
				kind: "melian.findings",
				version: 9,
				scope: "conversation",
				history: "rewindable",
				fork: "asOf",
				initial: () => structuredClone(main.findings),
			});
			await root.commit(async (tx) => {
				await tx.doc(old, root.id);
			}, context);
			await first.close(context);
			const second = await open();
			harnesses.push(second);
			expect(await second.snapshot(FindingsDocument, root.id, context)).toEqual(main.findings);
			const before = await readFindings(second, root.id, "base..accepted", context);
			const finding = before.find((each) => each.properties.cause === cause)!;
			expect(finding.properties.status).toBe("dismissed");
			expect(finding.properties.verification?.lowered).toMatchObject({ from: "P2", to: "P3" });
			const stored = main.findings.items[finding.id as keyof typeof main.findings.items];
			const sighting = stored.sightings["base..accepted"]["lens.trust-boundary@1"];
			const reported = Finding.parse({ ...sighting, properties: { ...sighting.properties, status: "new" } });
			const reopened = await second.root(context);
			await reopened.commit(
				(tx) => upsertFinding(tx, root.id, reported, "base..same", reported.properties.trigger!.proof),
				context,
			);
			expect((await readFindings(second, root.id, "base..same", context))[0]!.properties.status).toBe("dismissed");
			await second.close(context);
			const third = await open();
			harnesses.push(third);
			expect(
				(await third.snapshot(FindingsDocument, root.id, context))!.items[finding.id]!.lifecycle.dismissedTrigger,
			).toEqual(main.findings.items[finding.id as keyof typeof main.findings.items].lifecycle.dismissedTrigger);
			const trigger =
				cause === "introduced"
					? { ...reported.properties.trigger!, hash: snippetHash("changed trigger") }
					: reported.properties.trigger!;
			const changed = Finding.from({ ...reported.toJSON(), properties: { ...reported.properties, trigger } });
			const current = await third.root(context);
			await current.commit(async (tx) => {
				await upsertFinding(tx, root.id, changed, "base..changed", [
					{ file: "src/cache.ts", hash: snippetHash("changed proof") },
				]);
				await upsertVerification(
					tx,
					root.id,
					"base..changed",
					finding.id,
					finding.properties.source,
					finding.properties.verification!,
				);
			}, context);
			const after = (await readFindings(third, root.id, "base..changed", context))[0]!;
			expect(after.properties.status).toBe("new");
			expect(after.properties.pastDismissals).toMatchObject([
				{ reason: "Accepted this trigger and proof.", reopenedRevision: "base..changed" },
			]);
			const verdict = new Adjudication({
				findings: [after],
				config: defaultConfig,
				manifest: [],
				checks: [],
			}).adjudicate();
			expect(verdict.findings.acknowledge).toHaveLength(1);
			expect(verdict.findings.acknowledge[0]!.properties.decidedBy?.trustFloor).toMatchObject([
				{ minimum: "acknowledge", severity: "P2" },
			]);
			expect(verdict.reviewStatus().state).toBe("failure");
		} finally {
			for (const harness of harnesses) await harness.close(context);
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
