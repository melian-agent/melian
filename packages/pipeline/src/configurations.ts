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
	scrutinyLevels,
} from "@melian-agent/core";

import { lensSource } from "./lens-tools.ts";

const policyReview = "guardrail/policy-change-review";

/**
 * The policy a review's findings resolve under, and a fingerprint of what decides resolution: every path's table,
 * layers, and aliases, and the declared resolution each lens report resolves through. A budget, a model route, or a
 * tier changes none of those. Two reads that would resolve the findings alike give one fingerprint.
 */
export type PolicyLookup = ConfigFor & {
	readonly fingerprint: string;
	/** The fingerprint a build before the recipe changed would give this policy, to read a task input that build stored. */
	readonly legacyFingerprint: string;
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
	for (const lens of variants) {
		const settings = Object.hasOwn(tuning, lens.name) ? tuning[lens.name] : undefined;
		for (const { version } of [lens, lens.configured(settings)]) {
			for (const level of [undefined, ...scrutinyLevels]) {
				lensVariants[`${lens.name}@${lensSource(lens.name, version, level).version}`] = lens.resolution ?? null;
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
			const above = variants.filter((lens) => lens.scope === "" || path.startsWith(`${lens.scope}/`));
			for (const lens of above.sort((left, right) => left.scope.length - right.scope.length)) {
				if (lens.resolution === undefined) delete lensDefaults[lens.name];
				else lensDefaults[lens.name] = lens.resolution;
			}
			defaultsAt.set(path, lensDefaults);
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
	const byPath = [...atPath]
		.sort(([left], [right]) => (left < right ? -1 : 1))
		.map(([path, { lensVariants: _, ...policy }]) => [path, policy]);
	// A lens variant is named by its version in `lensVariants`, and a version hashes everything the lens runs with, its
	// budget included. So the fingerprint holds what each lens report resolves through: the declared default its
	// variant maps to, or the nearest lens's where that variant is no longer defined.
	const declared = findings
		.flatMap(({ properties: { path, source, reportedBy = [source] } }) =>
			reportedBy
				.filter(({ check }) => check.startsWith("lens."))
				.map(({ check, version }) => {
					const name = check.slice("lens.".length);
					const variant = `${name}@${version}`;
					const entry = Object.hasOwn(lensVariants, variant) ? lensVariants[variant] : defaultsAt.get(path)![name];
					return JSON.stringify([path, entry]);
				}),
		)
		.sort();
	const fingerprint = `2:${hash([byPath, declared])}`;
	// The first recipe hashed the layers whole, lens variants keyed by version included.
	const legacyFingerprint = hash([...atPath].sort(([left], [right]) => (left < right ? -1 : 1)));
	const policyFor: ConfigFor = (path, rule) => (rule === policyReview ? judging : atPath).get(path)!;
	return Object.assign(policyFor, { fingerprint, legacyFingerprint });
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
