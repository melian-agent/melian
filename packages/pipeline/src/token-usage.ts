import type { ModelUsage } from "@melian-agent/core";
import { copyJson, defineDocFamily } from "./harness.ts";

/** Per-model usage and its sum, copied from provider records. */
export type UsageSummary = { models: Record<string, ModelUsage>; total: ModelUsage };

// Separate from timing so older deterministic records remain distinguishable from reported zero usage.
export const ModelUsageDocument = defineDocFamily<{ usage?: UsageSummary }, null>({
	kind: "melian.model-usage",
	family: true,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
});

export const ModelAttemptsDocument = defineDocFamily<{ started: number; unmeasured: number }, null>({
	kind: "melian.model-attempts",
	family: true,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ started: 0, unmeasured: 0 }),
});

/** Accumulates provider counters without estimating tokens or recalculating prices. */
export class TokenUsage {
	private readonly models = new Map<string, ModelUsage>();

	constructor(models: Readonly<Record<string, ModelUsage>> = {}) {
		for (const [model, usage] of Object.entries(models)) this.add(model, usage);
	}

	/** Adds a returned response, including failed replies. */
	add(model: string, usage: ModelUsage): void {
		const previous = this.models.get(model);
		this.models.set(
			model,
			previous === undefined
				? (copyJson(usage, { omitUndefinedProperties: true }) as ModelUsage)
				: this.sum([previous, usage]),
		);
	}

	/** Includes a stage or pass once in this accumulator. */
	include(summary: UsageSummary): void {
		for (const [model, usage] of Object.entries(summary.models)) this.add(model, usage);
	}

	/** A detached JSON snapshot of reported counters and their sum. */
	toJSON(): UsageSummary {
		return { models: structuredClone(Object.fromEntries(this.models)), total: this.sum([...this.models.values()]) };
	}

	// Pi's adder is private; sum its reported totals instead of deriving them from token kinds.
	private sum(usages: readonly ModelUsage[]): ModelUsage {
		const total: ModelUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		for (const usage of usages) {
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
				total[key] += usage[key];
			for (const key of ["cacheWrite1h", "reasoning"] as const) {
				if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
			}
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
				total.cost[key] += usage.cost[key];
		}
		return total;
	}
}
