import { ModelRoutingError, parseModelReference, resolveModelForTier } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

function thrown(run: () => unknown): ModelRoutingError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ModelRoutingError);
		return error as ModelRoutingError;
	}
	throw new Error("expected a ModelRoutingError");
}

describe("resolveModelForTier", () => {
	it("routes a tier to its model and fallbacks in order", () => {
		const route = resolveModelForTier("heavy", {
			heavy: {
				model: "anthropic/claude-opus-4-1",
				fallbacks: ["openai/gpt-5", "openrouter/anthropic/claude-sonnet-4-5"],
			},
		});
		expect(route).toEqual({
			tier: "heavy",
			model: { provider: "anthropic", modelId: "claude-opus-4-1" },
			fallbacks: [
				{ provider: "openai", modelId: "gpt-5" },
				{ provider: "openrouter", modelId: "anthropic/claude-sonnet-4-5" },
			],
		});
	});

	it("gives a tier without fallbacks an empty list", () => {
		expect(resolveModelForTier("light", { light: { model: "openai/gpt-5-mini" } }).fallbacks).toEqual([]);
	});

	it("routes a route that names no model to the models its accept lists, in order", () => {
		const route = resolveModelForTier("verifier", { verifier: { accept: ["openai/gpt-5.5", "anthropic/opus"] } });
		expect(route.model).toEqual({ provider: "openai", modelId: "gpt-5.5" });
		expect(route.fallbacks).toEqual([{ provider: "anthropic", modelId: "opus" }]);
	});

	it("names the tier when no model is configured for it", () => {
		const error = thrown(() => resolveModelForTier("medium", { heavy: { model: "anthropic/claude-opus-4-1" } }));
		expect(error.code).toBe("noModelForTier");
		expect(error.tier).toBe("medium");
		expect(error.message).toContain("models.medium.model");
	});

	it("refuses a configured model that names no provider", () => {
		const error = thrown(() => resolveModelForTier("heavy", { heavy: { model: "opus", fallbacks: [] } }));
		expect(error).toMatchObject({ code: "invalidModel", tier: "heavy", model: "opus" });
	});

	it("refuses a fallback with an empty model ID", () => {
		const error = thrown(() =>
			resolveModelForTier("light", { light: { model: "openai/gpt-5-mini", fallbacks: ["anthropic/"] } }),
		);
		expect(error).toMatchObject({ code: "invalidModel", model: "anthropic/" });
	});
});

describe("parseModelReference", () => {
	it("splits at the first slash", () => {
		expect(parseModelReference("openrouter/meta/llama", "decision")).toEqual({
			provider: "openrouter",
			modelId: "meta/llama",
		});
	});
});
