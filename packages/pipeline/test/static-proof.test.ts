import { KeyedRequest } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	type Harness,
	openHarness,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CheckSources, ChecksDocument } from "../src/checks.ts";
import { FindingsDocument, replaceCheckFindings } from "../src/findings.ts";
import { StaticProof } from "../src/static-proof.ts";

const current = { guardrails: 1, "static.biome": 3, "static.tsc": 4, "static.enola": 3, "static.mutation": 3 };
const asked = KeyedRequest.of("check", { checks: current });

let harness: Harness | undefined;

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
});

async function root() {
	const fake = createFakeModels();
	harness = await openHarness(createMemoryStorage(), { models: fake.models, registry: createRegistry() });
	return harness.root(context, { agent: { model: fake.ref() } });
}

describe("the proof the checks document's requests give", () => {
	it("proves nothing for a root whose checks document was never written", async () => {
		const { id } = await root();
		const proof = await StaticProof.read(harness!, id, context);

		expect(proof.asks("static.biome", asked.key)).toBe(false);
	});

	it("proves a request stored under its key, and nothing for one canonical JSON refuses", async () => {
		const made = await root();
		await made.commit(async (tx) => {
			(await tx.doc(ChecksDocument, made.id)).requests = {
				[asked.key]: asked.request,
				["e".repeat(64)]: { checks: current, ratio: 1.5 },
			};
		}, context);
		const proof = await StaticProof.read(harness!, made.id, context);

		expect(proof.asks("static.biome", asked.key)).toBe(true);
		expect(proof.asks("static.biome", "e".repeat(64))).toBe(false);
	});

	// A request that could not key what its run read starts a run each time it is asked, so its stamp names no one run.
	it("keys a run fully only for a request whose install is identified and whose policy was read", async () => {
		const made = await root();
		const identified = { digests: { "package-lock.json": "a".repeat(64) }, identified: true };
		const requests = {
			keyed: { checks: current, install: identified, policy: [] },
			revision: { checks: current, install: identified },
			unidentified: { checks: current, install: { ...identified, identified: false }, policy: [] },
			unread: { checks: current, install: identified, policy: "unread" },
			"no install": { checks: current, policy: [] },
			"a truthy install flag": { checks: current, install: { ...identified, identified: "yes" } },
			"not an object": "keyed",
		};
		await made.commit(async (tx) => {
			(await tx.doc(ChecksDocument, made.id)).requests = requests;
		}, context);
		const proof = await StaticProof.read(harness!, made.id, context);

		expect(Object.fromEntries(Object.keys(requests).map((name) => [name, proof.keyedFully(name)]))).toEqual({
			keyed: true,
			revision: true,
			unidentified: false,
			unread: false,
			"no install": false,
			"a truthy install flag": false,
			"not an object": false,
		});
		expect(proof.keyedFully("never stored")).toBe(false);
	});

	// Two executions of one request stamp the same key, so the stamp's task must be the one the run's own task recorded.
	it("proves a check only when its stamp names the request and the check task the run's task recorded", async () => {
		const made = await root();
		const revision = "a".repeat(40);
		await made.commit(async (tx) => {
			(await tx.doc(ChecksDocument, made.id)).requests = { [asked.key]: asked.request };
			(await tx.doc(CheckSources, made.id, "1", null)).tasks = { "static.biome": 2, "static.tsc": 3 };
			(await tx.doc(CheckSources, made.id, "4", null)).tasks = { "static.biome": 5 };
			await replaceCheckFindings(tx, made.id, "static.biome", revision, [], { request: asked.key, task: 2 });
			await replaceCheckFindings(tx, made.id, "static.tsc", revision, [], { request: asked.key, task: 6 });
			await replaceCheckFindings(tx, made.id, "static.enola", revision, [], { request: asked.key, task: 7 });
		}, context);
		const state = await harness!.snapshot(FindingsDocument, made.id, context);
		const proves = async (run: number | undefined, check: string, request = asked.key) =>
			(
				await StaticProof.read(
					harness!,
					made.id,
					context,
					run === undefined ? undefined : { base: "b", head: "h", tier: "full", policy: "p", task: run },
				)
			).proves(state, revision, check, request);

		expect({
			"the task its run recorded": await proves(1, "static.biome"),
			"another task under the same request": await proves(1, "static.tsc"),
			"a check its run recorded no task for": await proves(1, "static.enola"),
			"the same check task from another run": await proves(4, "static.biome"),
			"a run whose task recorded nothing": await proves(9, "static.biome"),
			"no run": await proves(undefined, "static.biome"),
			"another request": await proves(1, "static.biome", "f".repeat(64)),
		}).toEqual({
			"the task its run recorded": true,
			"another task under the same request": false,
			"a check its run recorded no task for": false,
			"the same check task from another run": false,
			"a run whose task recorded nothing": false,
			"no run": false,
			"another request": false,
		});
	});
});
