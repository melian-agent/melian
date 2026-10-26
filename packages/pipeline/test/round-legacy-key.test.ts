import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Comparison } from "@melian-agent/core";
import {
	CompareHarness,
	ComparisonReader,
	backgroundContext as context,
	openSqliteStorage,
	RoundReader,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { expect, it } from "vitest";
import { ComparisonDocument } from "../src/compare.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { RoundsDocument, RoundWriter } from "../src/rounds.ts";

const fixture = new URL("./fixtures/rounds-head-only/", import.meta.url);
const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
	changeset: string;
	key: string;
};

it.each(["main", "rounds-v1"])("keeps main's head-only round key through a %s reopen and attribution", async (name) => {
	const directory = mkdtempSync(join(tmpdir(), "melian-round-key-"));
	const path = join(directory, "review.sqlite");
	copyFileSync(new URL(`${name}.sqlite`, fixture), path);
	const storage = await openSqliteStorage(path);
	try {
		const [round] = await new RoundReader(storage).read(recorded.changeset);
		expect(round!.stored).toMatchObject({ base: "", head: recorded.key, legacyKey: recorded.key, tasks: [] });
		expect(round!.verdict()?.status).toBe("passed");
		expect(round!.revisionKey()).toBe(recorded.key);
		const saved = round!.stored;
		const id = round!.id;
		await storage.close(context);
		const comparison = await CompareHarness.open(
			await openSqliteStorage(path),
			createFakeModels().review,
			recorded.changeset,
		);
		try {
			const root = await comparison.harness.root(context);
			await root.commit(async (tx) => {
				(await tx.doc(ComparisonDocument, root.id)).unattributed[recorded.key] = Comparison.of({
					base: "",
					head: recorded.key,
				}).toJSON();
				await new RoundWriter(tx, root.id).preserve(recorded.key);
				// Head-only adjudications predate the current findings-version guard.
				delete (await tx.doc(ReviewIndex, root.id)).reviews[recorded.key];
			}, context);
			const state = await comparison.harness.snapshot(RoundsDocument, root.id, context);
			expect(Object.keys(state!.current)).toEqual([recorded.key]);
			expect(`${recorded.changeset}.${state!.current[recorded.key]}`).toBe(id);
			await comparison.importFindings({ base: "", head: recorded.key, round: id }, [], "2026-10-27T00:00:00Z");
		} finally {
			await comparison.close(context);
		}
		const reopened = await openSqliteStorage(path);
		try {
			const rounds = await new RoundReader(reopened).read(recorded.changeset);
			expect(rounds.map((round) => ({ id: round.id, key: round.revisionKey() }))).toEqual([
				{ id, key: recorded.key },
			]);
			const [round] = rounds;
			expect(round!.id).toBe(id);
			expect(round!.revisionKey()).toBe(recorded.key);
			expect(round!.stored).toEqual(saved);
			const [entry] = await ComparisonReader.open(reopened).read(recorded.changeset);
			expect(entry!.round).toBe(id);
			expect(entry!.verdict?.toJSON()).toEqual(round!.verdict()!.toJSON());
		} finally {
			await reopened.close(context);
		}
	} finally {
		await storage.close(context);
		rmSync(directory, { recursive: true, force: true });
	}
});
