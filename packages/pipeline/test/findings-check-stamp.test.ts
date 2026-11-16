import { Finding } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	type Harness,
	openHarness,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { clearSightings, dismissFinding, FindingsDocument, replaceCheckFindings, stampOf } from "../src/findings.ts";
import type { ConversationId, Tx } from "../src/harness.ts";

const revision = "a".repeat(40);
const other = "b".repeat(40);
const run = "1".repeat(64);
const later = "2".repeat(64);

const biome = (line: number) =>
	Finding.create({
		rule: "lint/suspicious/noDebugger",
		message: "Biome reports lint/suspicious/noDebugger here.",
		file: "src/a.ts",
		startLine: line,
		snippet: `debugger; // ${line}`,
		occurrence: 0,
		cause: "introduced",
		severity: "P1",
		explanation: { what: "Biome reports a rule here.", whyHere: "The change adds it.", whatToDo: "Fix it." },
		source: { check: "static.biome", version: "2.5.0" },
	});

let harness: Harness | undefined;

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
});

// A root whose Biome and tsc checks each ran under `run`, at `revision` and at `other`, Biome with one finding.
async function stamped() {
	const fake = createFakeModels();
	harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
	const root = await harness.root(context, { agent: { model: fake.ref() } });
	await root.commit(async (tx) => {
		for (const at of [revision, other]) {
			await replaceCheckFindings(tx, root.id, "static.biome", at, [biome(1)], run);
			await replaceCheckFindings(tx, root.id, "static.tsc", at, [], run);
		}
	}, context);
	const stamps = async () => {
		const state = await harness!.snapshot(FindingsDocument, root.id, context);
		return {
			biome: stampOf(state, revision, "static.biome"),
			tsc: stampOf(state, revision, "static.tsc"),
			elsewhere: stampOf(state, other, "static.biome"),
		};
	};
	return { root, stamps };
}

describe("a check's stamp on its sightings at a revision", () => {
	it("is written by the run's terminal commit, after the sightings it writes, even with none", async () => {
		const { stamps } = await stamped();

		expect(await stamps()).toEqual({ biome: run, tsc: run, elsewhere: run });
	});

	it("names the latest run that replaced the check's sightings", async () => {
		const { root, stamps } = await stamped();
		await root.commit(
			(tx) => replaceCheckFindings(tx, root.id, "static.biome", revision, [biome(2)], later),
			context,
		);

		expect(await stamps()).toEqual({ biome: later, tsc: run, elsewhere: run });
	});

	it.each<[string, (tx: Tx, id: ConversationId) => Promise<void>]>([
		[
			"a sighting upserted by anything but the run",
			(tx: Tx, id: ConversationId) => upsertFinding(tx, id, biome(3), revision),
		],
		[
			"a replacement that names no run",
			(tx: Tx, id: ConversationId) => replaceCheckFindings(tx, id, "static.biome", revision, [biome(1)]),
		],
		[
			"a clear of the check's sightings for a rerun",
			(tx: Tx, id: ConversationId) =>
				clearSightings(tx, id, revision, [{ check: "static.biome", version: "2.5.0" }]),
		],
		[
			"a clear of another version of the check",
			(tx: Tx, id: ConversationId) =>
				clearSightings(tx, id, revision, [{ check: "static.biome", version: "1.9.0" }]),
		],
	])("is deleted by %s, and only for that check at that revision", async (_, write) => {
		const { root, stamps } = await stamped();
		await root.commit((tx) => write(tx, root.id), context);

		expect(await stamps()).toEqual({ biome: undefined, tsc: run, elsewhere: run });
	});

	it("is kept in a dismissal, which a later run's stamp does not change", async () => {
		const { root, stamps } = await stamped();
		const id = biome(1).id;
		await root.commit(
			(tx) =>
				dismissFinding(
					tx,
					root.id,
					id,
					{ by: "maintainer", reason: "Intended.", at: "2026-11-16" },
					revision,
					"P1",
				),
			context,
		);
		await root.commit(
			(tx) => replaceCheckFindings(tx, root.id, "static.biome", revision, [biome(1)], later),
			context,
		);
		const state = await harness!.snapshot(FindingsDocument, root.id, context);

		expect(state?.items[id]?.lifecycle.dismissedSighting?.run).toBe(run);
		expect((await stamps()).biome).toBe(later);
	});

	it("is absent from a dismissal made while no run stands", async () => {
		const { root } = await stamped();
		const id = biome(1).id;
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, biome(1), revision);
			await dismissFinding(
				tx,
				root.id,
				id,
				{ by: "maintainer", reason: "Intended.", at: "2026-11-16" },
				revision,
				"P1",
			);
		}, context);
		const state = await harness!.snapshot(FindingsDocument, root.id, context);

		expect(state?.items[id]?.lifecycle.dismissedSighting).not.toHaveProperty("run");
	});
});
