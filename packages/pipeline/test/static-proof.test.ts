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
import { ChecksDocument } from "../src/checks.ts";
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
});
