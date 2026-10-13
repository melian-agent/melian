import { createHash } from "node:crypto";
import {
	type ConfigFor,
	configLookup,
	type Finding,
	Lens,
	loadConfig,
	type MelianConfig,
	type PolicyAt,
	type RepositorySource,
	type ResolutionEntry,
	scrutinyLevels,
} from "@melian-agent/core";

import { lensSource } from "./lens-tools.ts";

const policyReview = "guardrail/policy-change-review";

/**
 * The policy a review's findings resolve under, and a fingerprint of all of it: every path's table, layers, aliases,
 * and lens defaults. Two reads that would resolve the findings alike give one fingerprint.
 */
export type PolicyLookup = ConfigFor & { readonly fingerprint: string };

/**
 * The policy each of `findings` resolves under, read from `policy`: the configuration at its path with each file's own
 * resolution layer, and, for a lens finding, the declared default of each lens as it applies there, read from the same
 * source as the lens. A policy-change-review finding resolves under the configuration that judged it, not its path's
 * own, so a `melian.yaml` cannot resolve the review of a change to itself.
 */
export async function configsFor(
	repoRoot: string,
	policy: RepositorySource,
	findings: readonly Finding[],
): Promise<PolicyLookup> {
	const lookup = configLookup(repoRoot, policy);
	const atPath = new Map<string, PolicyAt>();
	const judging = new Map<string, PolicyAt>();
	let tuning: MelianConfig["lenses"] | undefined;
	const lensPaths = new Set(
		findings
			.filter(({ properties: { source, reportedBy = [source] } }) =>
				reportedBy.some(({ check }) => check.startsWith("lens.")),
			)
			.map(({ properties }) => properties.path),
	);
	for (const { ruleId, properties } of findings) {
		const { path } = properties;
		if (!atPath.has(path)) {
			const { config, resolutionLayers } = await loadConfig(repoRoot, policy, path);
			// No prototype, so a lens named `constructor` is looked up like any other.
			const lensDefaults: Record<string, ResolutionEntry> = Object.create(null);
			const lensVariants: Record<string, ResolutionEntry | null> = Object.create(null);
			if (lensPaths.has(path)) {
				tuning ??= (await loadConfig(repoRoot, policy, ".")).config.lenses;
				// A moved file is reviewed by the lens of the folder it left, so every variant from the root down to the
				// path may have reported here. Each is listed under the versions a finding's source can name it by: as it
				// loaded and as the root's settings tune it, at every level. The nearest of a name, the one defined
				// deepest, gives the default for a report whose variant is none of them.
				const ancestors = path.split("/").map((_, depth, segments) => segments.slice(0, depth).join("/") || ".");
				const variants = await Lens.load(repoRoot, policy, ancestors);
				for (const lens of [...variants].sort((left, right) => left.scope.length - right.scope.length)) {
					if (lens.resolution === undefined) delete lensDefaults[lens.name];
					else lensDefaults[lens.name] = lens.resolution;
					const settings = Object.hasOwn(tuning, lens.name) ? tuning[lens.name] : undefined;
					for (const { version } of [lens, lens.configured(settings)]) {
						for (const level of [undefined, ...scrutinyLevels]) {
							lensVariants[`${lens.name}@${lensSource(lens.name, version, level).version}`] =
								lens.resolution ?? null;
						}
					}
				}
			}
			atPath.set(path, {
				resolution: config.resolution,
				ruleAliases: config.ruleAliases,
				layers: resolutionLayers,
				lensDefaults,
				lensVariants,
			});
		}
		if (ruleId === policyReview && !judging.has(path)) {
			const { config, resolutionLayers } = await lookup.policyReview(path);
			judging.set(path, {
				resolution: config.resolution,
				ruleAliases: config.ruleAliases,
				layers: resolutionLayers,
			});
		}
	}
	// What judges a notice is the layers above its file, which the file's own path already holds.
	const byPath = [...atPath].sort(([left], [right]) => (left < right ? -1 : 1));
	const fingerprint = createHash("sha256").update(JSON.stringify(byPath)).digest("hex").slice(0, 16);
	const policyFor: ConfigFor = (path, rule) => (rule === policyReview ? judging : atPath).get(path)!;
	return Object.assign(policyFor, { fingerprint });
}
