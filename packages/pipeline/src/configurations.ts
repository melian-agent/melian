import { createHash } from "node:crypto";
import {
	type ConfigFor,
	canonicalJson,
	configLookup,
	type Finding,
	Lens,
	loadConfig,
	type PolicyAt,
	type RepositorySource,
	type ResolutionEntry,
	scrutinyLevels,
} from "@melian-agent/core";

import { lensSource } from "./lens-tools.ts";

const policyReview = "guardrail/policy-change-review";
// Raised whenever the fingerprint's computation changes, so a stored fingerprint says which computation made it.
export const fingerprintVersion = 3;

// YAML keeps the order a file writes its keys in, and resolution looks each one up, so order must not move the hash.
// The JSON round trip drops the absent fields canonical JSON refuses.
const canonical = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));

/**
 * The policy a review's findings resolve under, and a fingerprint of what decides resolution: every path's table,
 * layers, and aliases, and the declared resolution each lens report resolves through. A budget, a model route, or a
 * tier changes none of those. Two reads that would resolve the findings alike give one fingerprint.
 */
export type PolicyLookup = ConfigFor & {
	readonly fingerprint: string;
	// The same policy under version 2's computation, which a review stored before version 3 must equal.
	readonly versionTwo: string;
};

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
	const defaultsAt = new Map<string, Record<string, ResolutionEntry>>();
	const nearestScopesAt = new Map<string, Record<string, string>>();
	const judging = new Map<string, PolicyAt>();
	const lensPaths = new Set(
		findings
			.filter(({ properties: { source, reportedBy = [source] } }) =>
				reportedBy.some(({ check }) => check.startsWith("lens.")),
			)
			.map(({ properties }) => properties.path),
	);
	// A moved file is reviewed by the lens of the folder it left, which may be any folder, so every variant the source
	// defines may have reported anywhere. Each is listed under the versions a finding's source can name it by: as it
	// loaded and as the root's settings tune it, bare and at every level. No prototype, so a lens named `constructor`
	// is looked up like any other.
	const [variants, tuning] =
		lensPaths.size === 0
			? [[], {}]
			: [await Lens.everywhere(repoRoot, policy), (await loadConfig(repoRoot, policy, ".")).config.lenses];
	const lensVariants: Record<string, ResolutionEntry | null> = Object.create(null);
	const variantScopes: Record<string, string> = Object.create(null);
	for (const lens of variants) {
		const settings = Object.hasOwn(tuning, lens.name) ? tuning[lens.name] : undefined;
		for (const { version } of [lens, lens.configured(settings)]) {
			for (const level of [undefined, ...scrutinyLevels]) {
				const variant = `${lens.name}@${lensSource(lens.name, version, level).version}`;
				lensVariants[variant] = lens.resolution ?? null;
				variantScopes[variant] = lens.scope;
			}
		}
	}
	for (const { ruleId, properties } of findings) {
		const { path } = properties;
		if (!atPath.has(path)) {
			const { config, resolutionLayers } = await loadConfig(repoRoot, policy, path);
			// The nearest lens of a name, the one defined deepest above the path, gives the default for a report whose
			// variant is none of those listed.
			const lensDefaults: Record<string, ResolutionEntry> = Object.create(null);
			const nearestScopes: Record<string, string> = Object.create(null);
			const above = variants.filter((lens) => lens.scope === "" || path.startsWith(`${lens.scope}/`));
			for (const lens of above.sort((left, right) => left.scope.length - right.scope.length)) {
				nearestScopes[lens.name] = lens.scope;
				if (lens.resolution === undefined) delete lensDefaults[lens.name];
				else lensDefaults[lens.name] = lens.resolution;
			}
			defaultsAt.set(path, lensDefaults);
			nearestScopesAt.set(path, nearestScopes);
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
	const paths = [...atPath.keys()].sort();
	const byPath = paths.map((path) => {
		const { lensVariants: _, ...policy } = atPath.get(path)!;
		return [path, policy] as const;
	});
	// A lens variant is named by its version in `lensVariants`, and a version hashes everything the lens runs with, its
	// budget included. So the fingerprint holds what each lens report resolves through: the declared default its
	// variant maps to, or the nearest lens's where that variant is no longer defined. Each entry keeps the name and
	// scope of the lens that gave it, which name a variant without its budget: a file moved out of a folder keeps that
	// folder's lenses, which no path default names, so two of them could otherwise swap their defaults unseen.
	const reports = findings.flatMap(({ properties: { path, source, reportedBy = [source] } }) =>
		reportedBy
			.filter(({ check }) => check.startsWith("lens."))
			.map(({ check, version }) => {
				const name = check.slice("lens.".length);
				const variant = `${name}@${version}`;
				const [entry, scope] = Object.hasOwn(lensVariants, variant)
					? [lensVariants[variant], variantScopes[variant]]
					: [defaultsAt.get(path)![name], nearestScopesAt.get(path)![name]];
				return { path, name, scope, entry };
			}),
	);
	const declared = reports.map(({ path, name, scope, entry }) => canonical([path, name, scope ?? null, entry])).sort();
	const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
	// Adjudication reads an alias's rules as a set, in either form, as core's `entryOf` does, so neither their order, a
	// repeat, nor the form moves the hash.
	const aliasSets = byPath.map(([path, { ruleAliases, ...rest }]) => [
		path,
		{
			...rest,
			ruleAliases: Object.fromEntries(
				Object.entries(ruleAliases).map(([rule, entry]) => {
					const [rules, distinct] = "rules" in entry ? [entry.rules, entry.distinct === true] : [entry, false];
					return [rule, { rules: [...new Set(rules)].sort(), distinct }];
				}),
			),
		},
	]);
	const fingerprint = `${fingerprintVersion}:${hash(canonical([aliasSets, declared]))}`;
	// Version 2's recipe, unchanged: plain JSON in file order, and each lens report's default without its name or scope.
	const versionTwo = `2:${hash(JSON.stringify([byPath, reports.map(({ path, entry }) => JSON.stringify([path, entry])).sort()]))}`;
	const policyFor: ConfigFor = (path, rule) => (rule === policyReview ? judging : atPath).get(path)!;
	return Object.assign(policyFor, { fingerprint, versionTwo });
}
