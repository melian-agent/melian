import {
	type ConfigFor,
	configLookup,
	type Finding,
	loadConfig,
	type MelianConfig,
	type RepositorySource,
} from "@melian-agent/core";

const policyReview = "guardrail/policy-change-review";

// A policy-change-review finding resolves under the configuration that judged it, not its path's own, so a
// melian.yaml cannot resolve the review of a change to itself.
export async function configsFor(
	repoRoot: string,
	policy: RepositorySource,
	findings: readonly Finding[],
): Promise<ConfigFor> {
	const lookup = configLookup(repoRoot, policy);
	const atPath = new Map<string, MelianConfig>();
	const judging = new Map<string, MelianConfig>();
	for (const { ruleId, properties } of findings) {
		const { path } = properties;
		if (!atPath.has(path)) atPath.set(path, (await loadConfig(repoRoot, policy, path)).config);
		if (ruleId === policyReview && !judging.has(path)) judging.set(path, await lookup.policyReview(path));
	}
	return (path, rule) => (rule === policyReview ? judging : atPath).get(path)!;
}
