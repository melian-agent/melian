import {
	type MelianConfig,
	type ModelRoute,
	type ModelTier,
	modelTiers,
	thinkingLevelSchema,
	visibleText,
} from "@melian-agent/core";
import Value from "typebox/value";

/** One live eval run's tier reasoning overrides. */
export class EvalThinking {
	private readonly levels: Partial<Record<ModelTier, NonNullable<ModelRoute["thinking"]>>>;

	private constructor(levels: Partial<Record<ModelTier, NonNullable<ModelRoute["thinking"]>>>) {
		this.levels = levels;
	}

	/** Parses MELIAN_EVAL_THINKING, refusing malformed, repeated or unknown tiers and levels. */
	static parse(value = ""): EvalThinking {
		const levels: Partial<Record<ModelTier, NonNullable<ModelRoute["thinking"]>>> = {};
		for (const entry of value === "" ? [] : value.split(",")) {
			const [tier, level, ...extra] = entry.split("=").map((part) => part.trim());
			if (
				!modelTiers.includes(tier as ModelTier) ||
				!Value.Check(thinkingLevelSchema, level) ||
				extra.length !== 0 ||
				Object.hasOwn(levels, tier!)
			)
				throw new Error(
					`MELIAN_EVAL_THINKING needs distinct tier=level entries; invalid entry ${visibleText(JSON.stringify(entry))}`,
				);
			levels[tier as ModelTier] = level;
		}
		return new EvalThinking(levels);
	}

	/** The override for the tier a direct triage request serves. */
	level(tier: ModelTier): ModelRoute["thinking"] {
		return this.levels[tier];
	}

	/** Applies levels after model overrides, preserving every route's other settings. */
	apply(config: MelianConfig): MelianConfig {
		const models = { ...config.models };
		for (const [tier, thinking] of Object.entries(this.levels))
			models[tier as ModelTier] = { ...models[tier as ModelTier], thinking };
		return { ...config, models };
	}
}
