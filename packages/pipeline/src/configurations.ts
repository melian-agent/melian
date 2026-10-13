import { createHash } from "node:crypto";
import {
	type ConfigFor,
	configLookup,
	type Finding,
	Lens,
	loadConfig,
	type PolicyAt,
	type RepositorySource,
	type ResolutionEntry,
} from "@melian-agent/core";

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
			for (const lens of lensPaths.has(path) ? await Lens.load(repoRoot, policy, [path]) : []) {
				if (lens.resolution !== undefined) lensDefaults[lens.name] = lens.resolution;
			}
			atPath.set(path, {
				resolution: config.resolution,
				ruleAliases: config.ruleAliases,
				layers: resolutionLayers,
				lensDefaults,
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
