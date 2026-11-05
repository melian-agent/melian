// Raises every committed lens's top-level budget to a round's, in the melian-round workflow's throwaway checkout.
// Usage: node scripts/round-budgets.mjs <lenses directory>
import { raiseBudgets } from "./round.mjs";

const directory = process.argv[2];
if (directory === undefined) {
	process.stderr.write("usage: node scripts/round-budgets.mjs <lenses directory>\n");
	process.exit(64);
}
process.stdout.write(`raised: ${raiseBudgets(directory).join(", ")}\n`);
