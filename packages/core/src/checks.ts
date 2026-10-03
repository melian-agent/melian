import type { MelianConfig } from "./config.ts";
import { CheckError } from "./errors.ts";

/**
 * The checks a tier names, in order and without repeats: a review's manifest. A name that is itself a tier expands to
 * that tier's checks. Throws {@link CheckError} `unknownTier` for a tier the configuration does not define, and
 * `tierCycle` for a tier that includes itself.
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
		if (path.includes(name)) throw new CheckError("tierCycle", tier, `tier ${[...path, name].join(" includes ")}`);
		const tierChecks = Object.hasOwn(config.tiers, name) ? config.tiers[name] : undefined;
		if (tierChecks === undefined) checks.add(name);
		else for (const each of tierChecks) expand(each, [...path, name]);
	};
	expand(tier, []);
	return [...checks];
}
