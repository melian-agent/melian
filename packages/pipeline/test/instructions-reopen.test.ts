import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, defaultConfig } from "@melian-agent/core";
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
import { RoundsDocument } from "../src/rounds.ts";

// Written by main before instruction files; its README says how.
const recorded = JSON.parse(
	readFileSync(new URL("./fixtures/instructions-previous/review.json", import.meta.url), "utf8"),
) as {
	versions: { findings: number; verdicts: number; published: number; rounds: number };
	findings: JsonObject;
	verdicts: JsonObject;
	published: JsonObject;
	rounds: JsonObject;
};

const documents = [
	["melian.findings", recorded.versions.findings, "rewindable", recorded.findings],
	["melian.verdicts", recorded.versions.verdicts, "rewindable", recorded.verdicts],
	["melian.published", recorded.versions.published, "latest", recorded.published],
	["melian.rounds", recorded.versions.rounds, "latest", recorded.rounds],
] as const;

const token = (kind: string, version: number, history: "rewindable" | "latest") =>
	history === "latest"
		? defineDoc<JsonObject>({ kind, version, initial: () => ({}), scope: "conversation", history, fork: "current" })
		: defineDoc<JsonObject>({ kind, version, initial: () => ({}), scope: "conversation", history, fork: "asOf" });

it("takes the next version of each document that holds a finding", () => {
	expect(recorded.versions).toEqual({ findings: 11, verdicts: 15, published: 11, rounds: 4 });
	expect([
		FindingsDocument.definition.version,
		VerdictDocument.definition.version,
		PublishedDocument.definition.version,
		RoundsDocument.definition.version,
	]).toEqual([12, 16, 12, 5]);
});

it("reopens main's documents unchanged, decides them anew, and an older reader refuses what this build wrote", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "melian-instructions-reopen-")));
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
			for (const [kind, version, history, value] of documents)
				Object.assign(await tx.doc(token(kind, version, history), root.id), value);
		}, context);
		await first.close(context);

		const second = await open();
		harnesses.push(second);
		expect(await second.snapshot(FindingsDocument, root.id, context)).toEqual(recorded.findings);
		expect(await second.snapshot(VerdictDocument, root.id, context)).toEqual(recorded.verdicts);
		expect(await second.snapshot(PublishedDocument, root.id, context)).toEqual(recorded.published);
		expect(await second.snapshot(RoundsDocument, root.id, context)).toEqual(recorded.rounds);
		const previous = (await readVerdict(second, root.id, "base..head", context))!;
		expect(previous.findings.acknowledge.map((finding) => finding.ruleId)).toEqual(["guardrail/policy-change-review"]);
		expect(previous.findings.block.map((finding) => finding.ruleId)).toEqual(["melian/injection-attempt"]);
		// Main's notice names no instruction file, so the injection finding it stored still stands.
		const findings = await readFindings(second, root.id, "base..head", context);
		const verdict = new Adjudication({ findings, config: defaultConfig, manifest: [], checks: [] }).adjudicate();
		expect(verdict.toJSON()).toEqual(previous.toJSON());
		const current = await second.root(context);
		await current.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).verdicts["base..head"] = verdict.toJSON();
			await tx.doc(FindingsDocument, root.id);
			await tx.doc(PublishedDocument, root.id);
			await tx.doc(RoundsDocument, root.id);
		}, context);
		await second.close(context);

		const third = await open();
		harnesses.push(third);
		for (const [kind, version, history] of documents)
			await expect(third.snapshot(token(kind, version, history), root.id, context)).rejects.toThrow(/newer version/);
	} finally {
		for (const harness of harnesses) await harness.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});
