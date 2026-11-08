// Prints whether the committed root policy at <commit> trusts writers, `true` or `false`, as `melian publish` reads it.
// A policy that cannot be read prints `false`, so a round sets no success it could not justify.
// Usage: node scripts/round-trust.mjs <repository directory> <commit>
import { loadConfig } from "../packages/core/src/config.ts";

const [repoRoot, commit] = process.argv.slice(2);
let trusted = false;
try {
	trusted = (await loadConfig(repoRoot ?? "", { kind: "revision", commit: commit ?? "" }, ".")).config.trust.writers;
} catch {
	trusted = false;
}
process.stdout.write(`${trusted === true}\n`);
