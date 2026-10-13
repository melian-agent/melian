import { posix } from "node:path";
import { loadConfig } from "./config.ts";
import { Lens } from "./lens.ts";
import { ResolutionWalk } from "./resolution.ts";
import { openSource, type RepositorySource } from "./source.ts";

// A `melian.yaml` or a `LENS.md` at any depth, as git lists paths: the whole last segment.
const policyFile = /(?:^|\/)(?:melian\.yaml|LENS\.md)$/;

/**
 * What each file's `resolution` overrides across the repository at `repoRoot`, one sentence each, for `melian doctor`:
 * the accepted cost of letting the nearest file that speaks decide a finding whole. Every directory that holds a
 * `melian.yaml` in `source` is walked, and the root, and every folder that defines a lens, since a lens there may
 * declare a default a farther table overrides. Each walk takes each lens's declared default as the lens applies in
 * that directory ({@link ResolutionWalk.overrides}). From the working tree the preference files come first on each walk, as a review
 * of the working tree reads them. Throws as {@link loadConfig} and {@link Lens.load} do.
 */
export async function resolutionOverrides(repoRoot: string, source: RepositorySource): Promise<string[]> {
	const reader = await openSource(repoRoot, source);
	const files = await reader.findPaths(policyFile);
	// The root is walked even with no melian.yaml of its own: a preference file there may speak. A lens's own directory
	// lies beneath the folder that defines it, so walking it reads that folder's lenses and every file above.
	const directories = [".", ...files.map((file) => posix.dirname(file))];
	const lines = new Set<string>();
	for (const directory of directories) {
		const { resolutionLayers } = await loadConfig(repoRoot, source, directory);
		const declared = (await Lens.load(repoRoot, source, [directory])).flatMap((lens) =>
			lens.resolution === undefined ? [] : [[lens.name, lens.resolution] as const],
		);
		for (const line of new ResolutionWalk(resolutionLayers, Object.fromEntries(declared)).overrides())
			lines.add(line);
	}
	return [...lines];
}
