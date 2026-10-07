import type { MelianConfig } from "./config.ts";
import { CheckError } from "./errors.ts";

/** The checks Melian runs without a model. Lenses (`lens.<name>`) and decision questions (`decisions.<name>`) run elsewhere. */
export const deterministicChecks = ["guardrails", "static.biome", "static.tsc", "static.enola"] as const;

/** A check Melian runs without a model. */
export type DeterministicCheck = (typeof deterministicChecks)[number];

// A check name that stands for several.
const groups: Readonly<Record<string, readonly string[]>> = { static: ["static.biome", "static.tsc"] };

/**
 * The checks a tier names, in order and without repeats. A name that is itself a tier expands to that tier's checks, and
 * `static` expands to Biome and tsc; name `static.enola` explicitly. Throws `CheckError` `unknownTier` for a tier the configuration does not define,
 * and `tierCycle` for a tier that includes itself.
 */
export function checksOfTier(config: Pick<MelianConfig, "tiers">, tier: string): string[] {
	if (!Object.hasOwn(config.tiers, tier)) {
		throw new CheckError(
			"unknownTier",
			tier,
			`no tier is named ${tier}; tiers are ${Object.keys(config.tiers).join(", ")}`,
		);
	}
	const checks = new Set<string>();
	const expand = (name: string, path: readonly string[]) => {
		if (path.includes(name)) {
			throw new CheckError("tierCycle", tier, `tier ${[...path, name].join(" includes ")}`);
		}
		const tierChecks = Object.hasOwn(config.tiers, name) ? config.tiers[name] : undefined;
		if (tierChecks !== undefined) {
			for (const each of tierChecks) expand(each, [...path, name]);
		} else {
			for (const each of Object.hasOwn(groups, name) ? groups[name]! : [name]) checks.add(each);
		}
	};
	expand(tier, []);
	return [...checks];
}
