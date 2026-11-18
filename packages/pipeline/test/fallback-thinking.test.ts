import { rmSync } from "node:fs";
import { Changeset, defaultConfig, Lens, type MelianConfig, type ModelRoute, Revision } from "@melian-agent/core";
import { FallbackDecider } from "@melian-agent/decisions";
import { expect, it } from "vitest";
import { createMemoryStorage } from "../src/harness.ts";
import { RouteTextModel } from "../src/models.ts";
import { openReviewHarness, reviewChangeset } from "../src/review.ts";
import { summarizeReview } from "../src/summarize.ts";
import { TelemetryReader } from "../src/telemetry.ts";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptVerifier,
	systemPromptOf,
} from "../src/testing.ts";
import { crashFinding, crashRepository } from "./fixtures/review-scenario.ts";

type Level = NonNullable<ModelRoute["thinking"]>;

// Triage and the walkthrough take the first model of their route the catalogue knows, so their first models are left
// out of it; the lens and verifier routes fail over from a model that answers with an error.
async function review(own: boolean) {
	const repo = crashRepository();
	const fake = createFakeModels({
		models: ["unavailable", "finder", "judge-unavailable", "judge", "summary", "triage"].map((id) => ({ id })),
	});
	const asked: [string, unknown][] = [];
	fake.provider.setResponses(
		Array.from({ length: 40 }, () => async (request, options, _state, model) => {
			asked.push([model.id, options?.reasoning]);
			const prompt = systemPromptOf(request.messages);
			if (model.id.endsWith("unavailable"))
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit exceeded" });
			if (model.id === "triage")
				return fauxAssistantMessage(
					fauxToolCall("answer", {
						answers: [{ question: "correctness", probabilities: [{ option: "careful", probability: 1 }] }],
					}),
					{ stopReason: "toolUse" },
				);
			if (model.id === "finder") {
				expect(prompt).toContain("correctness reviewer");
				return request.messages.some((message) => message.role === "toolResult")
					? fauxAssistantMessage("Done.")
					: fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" });
			}
			if (model.id === "judge") return scriptVerifier(request.messages);
			expect(model.id).toBe("summary");
			return fauxAssistantMessage(
				fauxToolCall("record_walkthrough", {
					summary: "Changes manager lookup.",
					files: [{ path: "src/user.ts", summary: "Removes the optional chain." }],
				}),
				{ stopReason: "toolUse" },
			);
		}),
	);
	const fallback = (model: string, thinking: Level) => (own ? { model, thinking } : model);
	const config: MelianConfig = {
		...defaultConfig,
		tiers: { full: ["lens.correctness"] },
		models: {
			heavy: { model: "faux/unavailable", thinking: "low", fallbacks: [fallback("faux/finder", "high")] },
			verifier: { model: "faux/judge-unavailable", thinking: "low", fallbacks: [fallback("faux/judge", "high")] },
			light: {
				model: "faux/summary-unavailable",
				thinking: "minimal",
				fallbacks: [fallback("faux/summary", "medium")],
			},
		},
	};
	const triage = own ? { ...fake.ref("triage"), thinking: "high" as const } : fake.ref("triage");
	const text = (await RouteTextModel.create(
		fake.review,
		[{ provider: "faux", modelId: "triage-unavailable" }, triage],
		"low",
	))!;
	const decider = new FallbackDecider(text);
	const storage = createMemoryStorage();
	const opened = await openReviewHarness(storage, fake.review, { decider, retry: false });
	try {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const options = {
			harness: opened,
			changeset,
			config,
			lenses: await Lens.builtins(),
			standards: [],
			models: fake.review,
			checks: [],
			decider,
			origin: {
				kind: "pull-request" as const,
				repository: { owner: "melian-agent", name: "example" },
				pullRequest: 7,
				base: changeset.revision.base,
				head: changeset.revision.head,
			},
		};
		await reviewChangeset(options);
		await summarizeReview({ ...options, harness: opened.harness });
		const telemetry = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		const requested = telemetry.stages.flatMap((stage) =>
			(stage.usage?.requests ?? []).map((request) => [request.model.split("/")[1]!, request.reasoning.requested]),
		);
		return { asked, requested };
	} finally {
		await opened.close();
		rmSync(repo, { recursive: true, force: true });
	}
}

it("asks each fallback at the level its entry names, and each first model at its route's", async () => {
	const levels: Record<string, string> = {
		unavailable: "low",
		finder: "high",
		"judge-unavailable": "low",
		judge: "high",
		summary: "medium",
		triage: "high",
	};
	const { asked, requested } = await review(true);
	expect(new Set(asked.map(([model]) => model))).toEqual(new Set(Object.keys(levels)));
	expect(asked).toEqual(asked.map(([model]) => [model, levels[model]]));
	expect(requested.length).toBeGreaterThan(0);
	expect(requested).toEqual(requested.map(([model]) => [model, levels[model!]]));
});

it("asks a bare fallback at its route's level", async () => {
	const levels: Record<string, string> = {
		unavailable: "low",
		finder: "low",
		"judge-unavailable": "low",
		judge: "low",
		summary: "minimal",
		triage: "low",
	};
	const { asked } = await review(false);
	expect(new Set(asked.map(([model]) => model))).toEqual(new Set(Object.keys(levels)));
	expect(asked).toEqual(asked.map(([model]) => [model, levels[model]]));
});
