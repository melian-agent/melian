import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The facts about the machine a deterministic result holds on: the operating system, the CPU architecture, the version
 * of the Node that runs Melian, and whether the filesystem under `directory` treats two spellings that differ only in
 * case as one name. A key that covers a tool's run names these as inputs, so a run on another host runs again.
 */
export type HostFacts = {
	readonly platform: string;
	readonly arch: string;
	readonly node: string;
	readonly caseFolds: boolean;
};

const answered = new Map<string, boolean>();

/** The facts of this host, asking the filesystem under `directory`, the system's temporary directory by default. */
export function hostFacts(directory: string = tmpdir()): HostFacts {
	return {
		platform: process.platform,
		arch: process.arch,
		node: process.versions.node,
		caseFolds: caseFolds(directory),
	};
}

// The filesystem answers, never the platform's name: a Mac can format a volume case-sensitive, and Linux can fold.
function caseFolds(directory: string): boolean {
	const known = answered.get(directory);
	if (known !== undefined) return known;
	const probe = mkdtempSync(join(directory, "melian-case-"));
	try {
		writeFileSync(join(probe, "probe"), "");
		const folds = existsSync(join(probe, "PROBE"));
		answered.set(directory, folds);
		return folds;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}
