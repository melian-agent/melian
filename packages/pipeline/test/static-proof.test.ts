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
});
