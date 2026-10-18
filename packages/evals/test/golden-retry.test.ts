import { rmSync } from "node:fs";
import { Changeset, Lens } from "@melian-agent/core";
import * as testing from "@melian-agent/pipeline/testing";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "@melian-agent/pipeline/testing";
import { expect, it, vi } from "vitest";
import { buildGoldenRepository, loadGoldens, runGolden } from "../src/goldens.ts";

const golden = loadGoldens().find((each) => each.name === "clean-rename")!;
const unavailable = fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 overloaded" });
const finished = fauxAssistantMessage("Done.");

it("retries a transient lens failure in live mode with a fake provider", async () => {
	const fake = createFakeModels({ provider: "retry-eval", models: [{ id: "lens" }] });
	const { repo, base } = buildGoldenRepository(golden);
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const lenses = (await Lens.load(repo, { kind: "revision", commit: base }, changeset.revision.paths())).filter(
			(lens) => Object.hasOwn(golden.script, lens.name),
		);
		const requests = scriptConversations(
			fake,
			lenses
				.filter((lens) => Object.hasOwn(golden.script, lens.name))
				.map((lens) => ({
					match: lens.instructions,
					replies: [unavailable, finished],
				})),
		);
		const run = await runGolden(golden, { kind: "live", models: fake.review, model: "retry-eval/lens" });
		expect(run.findings).toEqual([]);
		expect(Object.keys(requests)).toHaveLength(lenses.length);
		for (const seen of Object.values(requests)) expect(seen).toHaveLength(2);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}, 60_000);

it("fails a scripted golden on its first transient lens error", async () => {
	let requests: ReturnType<typeof scriptConversations> = {};
	const scripted = vi.spyOn(testing, "scriptLenses").mockImplementation((fake, lenses) => {
		requests = scriptConversations(
			fake,
			lenses
				.filter((lens) => Object.hasOwn(golden.script, lens.name))
				.map((lens) => ({
					match: lens.instructions,
					replies: [unavailable, finished],
				})),
		);
		return requests;
	});
	try {
		await expect(runGolden(golden, { kind: "scripted" })).rejects.toThrow("HTTP 503 overloaded");
		expect(Object.keys(requests).length).toBeGreaterThan(0);
		for (const seen of Object.values(requests)) expect(seen).toHaveLength(1);
	} finally {
		scripted.mockRestore();
	}
}, 60_000);
