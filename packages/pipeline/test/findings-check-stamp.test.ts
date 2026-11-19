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
const run = { request: "1".repeat(64), task: 7 };
const later = { request: "2".repeat(64), task: 9 };

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

	// Two executions of one request stamp the same key, so only the task tells them apart.
	it("names the latest task that replaced the check's sightings under the same request, and nothing more", async () => {
		const { root, stamps } = await stamped();
		const again = { ...run, task: 8, extra: true };
		await root.commit((tx) => replaceCheckFindings(tx, root.id, "static.biome", revision, [], again), context);

		expect(await stamps()).toEqual({ biome: { request: run.request, task: 8 }, tsc: run, elsewhere: run });
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
			"a replacement that names no run and finds nothing",
			(tx: Tx, id: ConversationId) => replaceCheckFindings(tx, id, "static.biome", revision, []),
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

	it("leaves no entry for a revision once its last check's stamp is deleted", async () => {
		const { root } = await stamped();
		await root.commit(
			(tx) =>
				clearSightings(tx, root.id, revision, [
					{ check: "static.biome", version: "2.5.0" },
					{ check: "static.tsc", version: "5.9.3" },
				]),
			context,
		);
		const state = await harness!.snapshot(FindingsDocument, root.id, context);

		expect(state?.checkRuns).toEqual({ [other]: { "static.biome": run, "static.tsc": run } });
	});

	it("reads as absent from a root with no findings document", () => {
		expect(stampOf(undefined, revision, "static.biome")).toBeUndefined();
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

		expect(state?.items[id]?.lifecycle.dismissedSighting?.run).toBe(run.request);
		expect((await stamps()).biome).toEqual(later);
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

	// A dismissal made before stamps carries no run, so repeating it after a stamped run is how its sighting gets proven.
	it("is taken into a repeated dismissal once a run stands, though nothing else changed", async () => {
		const { root } = await stamped();
		const id = biome(1).id;
		const dismissal = { by: "maintainer", reason: "Intended.", at: "2026-11-16" };
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, biome(1), revision);
			await dismissFinding(tx, root.id, id, dismissal, revision, "P1");
		}, context);
		await root.commit(
			(tx) => replaceCheckFindings(tx, root.id, "static.biome", revision, [biome(1)], later),
			context,
		);
		await root.commit(
			(tx) => dismissFinding(tx, root.id, id, { ...dismissal, at: "2026-11-17" }, revision, "P1"),
			context,
		);
		const state = await harness!.snapshot(FindingsDocument, root.id, context);

		expect(state?.items[id]?.lifecycle.dismissedSighting?.run).toBe(later.request);
	});

	// A repeat that names no severity records no sighting, so it has no run to take and changes nothing.
	it("is kept by a repeated dismissal that names no severity, after a later run", async () => {
		const { root } = await stamped();
		const id = biome(1).id;
		const dismissal = { by: "maintainer", reason: "Intended.", at: "2026-11-16" };
		await root.commit((tx) => dismissFinding(tx, root.id, id, dismissal, revision, "P1"), context);
		await root.commit(
			(tx) => replaceCheckFindings(tx, root.id, "static.biome", revision, [biome(1)], later),
			context,
		);
		const replaced = await root.commit(
			(tx) => dismissFinding(tx, root.id, id, { ...dismissal, at: "2026-11-17" }, revision),
			context,
		);
		const state = await harness!.snapshot(FindingsDocument, root.id, context);

		expect(replaced).toBeUndefined();
		expect(state?.items[id]?.lifecycle).toMatchObject({ dismissedAt: "2026-11-16", history: [] });
		expect(state?.items[id]?.lifecycle.dismissedSighting?.run).toBe(run.request);
	});

	// Only a static finding's dismissal is shared by its stamp, so another check's stamp is no part of its dismissal.
	it("is no part of a dismissal of another check's finding, whose repeat after a later run changes nothing", async () => {
		const { root } = await stamped();
		const guardrail = Finding.create({
			rule: "guardrail/forbidden-patterns",
			message: "This line matches a forbidden pattern.",
			file: "src/a.ts",
			startLine: 1,
			snippet: "export const a = 1;",
			occurrence: 0,
			cause: "introduced",
			severity: "P2",
			explanation: { what: "A pattern matches.", whyHere: "The change adds it.", whatToDo: "Remove it." },
			source: { check: "guardrails" },
		});
		const dismissal = { by: "maintainer", reason: "Intended.", at: "2026-11-16" };
		await root.commit(async (tx) => {
			await replaceCheckFindings(tx, root.id, "guardrails", revision, [guardrail], run);
			await dismissFinding(tx, root.id, guardrail.id, dismissal, revision, "P2");
		}, context);
		await root.commit((tx) => replaceCheckFindings(tx, root.id, "guardrails", revision, [guardrail], later), context);
		const replaced = await root.commit(
			(tx) => dismissFinding(tx, root.id, guardrail.id, { ...dismissal, at: "2026-11-17" }, revision, "P2"),
			context,
		);
		const { lifecycle } = (await harness!.snapshot(FindingsDocument, root.id, context))!.items[guardrail.id]!;

		expect(replaced).toBeUndefined();
		expect(lifecycle).toMatchObject({ dismissedAt: "2026-11-16", history: [] });
		expect(lifecycle.dismissedSighting).toBeDefined();
		expect(Object.hasOwn(lifecycle.dismissedSighting!, "run")).toBe(false);
	});
});
