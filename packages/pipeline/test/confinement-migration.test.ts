import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PublicationDetails, type StoredVerdict, Verdict } from "@melian-agent/core";
import {
	backgroundContext as context,
	createRegistry,
	defineDoc,
	type Harness,
	openHarness,
	openSqliteStorage,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { type CheckRunRecord, ChecksDocument } from "../src/checks.ts";
import { PublishedDocument } from "../src/publish.ts";

// The stored shapes as the code before the confinement field wrote them; see fixtures/stored-v6/README.md.
type Recorded = {
	checks: {
		checksVersion: number;
		checks: { runs: Record<string, Record<string, CheckRunRecord>>; tasks: Record<string, number> };
	};
	review: {
		verdictVersion: number;
		publishedVersion: number;
		verdicts: { verdicts: Record<string, StoredVerdict>; details: Record<string, PublicationDetails> };
		// The current document's own type, which the recorded one also satisfies: version 8 added only an optional field.
		published: ReturnType<(typeof PublishedDocument)["definition"]["initial"]>;
	};
};

function recorded(): Recorded {
	const read = (name: string) =>
		JSON.parse(readFileSync(new URL(`./fixtures/stored-v6/${name}.json`, import.meta.url), "utf8"));
	return { checks: read("checks"), review: read("review") };
}

let dir: string | undefined;
let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

it("reopens check, verdict, and published records written before confinement, and writes it beside them", async () => {
	const { checks, review } = recorded();
	expect([checks.checksVersion, review.verdictVersion, review.publishedVersion]).toEqual([3, 6, 7]);
	const oldChecks = defineDoc<Recorded["checks"]["checks"]>({
		kind: "melian.checks",
		version: 3,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({ runs: {}, tasks: {} }),
	});
	const oldVerdicts = defineDoc<Recorded["review"]["verdicts"]>({
		kind: "melian.verdicts",
		version: 6,
		scope: "conversation",
		history: "rewindable",
		fork: "asOf",
		initial: () => ({ verdicts: {}, details: {} }),
	});
	const oldPublished = defineDoc<Recorded["review"]["published"]>({
		kind: "melian.published",
		version: 7,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({ order: [], revisions: {}, ledgerRounds: [] }),
	});
	dir = mkdtempSync(join(tmpdir(), "melian-recorded-v6-"));
	const database = join(dir, "state.sqlite");
	const fake = createFakeModels();
	const open = async () =>
		openHarness(await openSqliteStorage(database), { models: fake.models, registry: createRegistry() }, context);
	harness = await open();
	let root = await harness.root(context);
	await root.commit(async (tx) => {
		Object.assign(await tx.doc(oldChecks, root.id), checks.checks);
		Object.assign(await tx.doc(oldVerdicts, root.id), review.verdicts);
		Object.assign(await tx.doc(oldPublished, root.id), review.published);
	}, context);
	await harness.close(context);

	// Reopened through the current definitions, every old record reads as it was written, with no confinement invented.
	harness = await open();
	root = await harness.root(context);
	expect(await harness.snapshot(ChecksDocument, root.id, context)).toEqual(checks.checks);
	expect(await harness.snapshot(VerdictDocument, root.id, context)).toEqual(review.verdicts);
	expect(await harness.snapshot(PublishedDocument, root.id, context)).toEqual(review.published);
	const revision = Object.keys(review.verdicts.verdicts)[0]!;
	const run = Object.keys(checks.checks.runs)[0]!;
	const old = Verdict.from((await harness.snapshot(VerdictDocument, root.id, context))!.verdicts[revision]!);
	expect(old.ran?.map((check) => check.name)).toContain("static.biome");
	expect(old.ran?.some((check) => check.confinement !== undefined)).toBe(false);
	expect(old.unconfined()).toEqual([]);
	expect(old.render()).not.toContain("sandbox");

	// Written through the current definitions, the field sits beside the old records and survives another reopen.
	const unconfined = { confined: false, reason: "this host offers no sandbox" } as const;
	await root.commit(async (tx) => {
		const biome = (await tx.doc(ChecksDocument, root.id)).runs[run]!["static.biome"]!;
		if (biome.status === "ran") biome.confinement = unconfined;
		const stored = (await tx.doc(VerdictDocument, root.id)).verdicts[revision]!;
		stored.ran!.find((check) => check.name === "static.biome")!.confinement = unconfined;
		const round = (await tx.doc(PublishedDocument, root.id)).ledgerRounds!.at(-1)!;
		if ("verdict" in round)
			round.verdict.ran!.find((check) => check.name === "static.tsc")!.confinement = { confined: true };
	}, context);
	await harness.close(context);
	harness = await open();
	root = await harness.root(context);
	expect((await harness.snapshot(ChecksDocument, root.id, context))!.runs[run]!["static.biome"]).toEqual({
		...checks.checks.runs[run]!["static.biome"],
		confinement: unconfined,
	});
	const now = Verdict.from((await harness.snapshot(VerdictDocument, root.id, context))!.verdicts[revision]!);
	expect(now.unconfined()).toEqual([{ name: "static.biome", reason: "this host offers no sandbox" }]);
	expect(now.render()).toContain(
		"1 check ran outside a sandbox:\n  static.biome  ran unconfined: this host offers no sandbox",
	);
	const round = (await harness.snapshot(PublishedDocument, root.id, context))!.ledgerRounds!.at(-1)!;
	expect(round).toHaveProperty("verdict.ran.2.confinement", { confined: true });

	// A build from before the field refuses these documents rather than read them and drop what they now say.
	await expect(harness.snapshot(oldChecks, root.id, context)).rejects.toThrow(/newer version 4 than 3/);
	await expect(harness.snapshot(oldVerdicts, root.id, context)).rejects.toThrow(/newer version 7 than 6/);
	await expect(harness.snapshot(oldPublished, root.id, context)).rejects.toThrow(/newer version 8 than 7/);
});
