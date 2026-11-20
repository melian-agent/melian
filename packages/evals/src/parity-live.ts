/**
 * Measures the parity arm against real models: on each miss in `MELIAN_EVAL_MISSES`, a review as the base commits it,
 * then one whose lenses share that review's lens spend with the design lens's capabilities. Spends real tokens, so it
 * runs only with `MELIAN_EVAL_LIVE=1`, and never in `npm run check`. `measureParity` reads the rest of the settings; a
 * malformed one, a head the invocation does not vouch for, a checkout with uncommitted changes, or a host that cannot
 * run probes exits 2 before any provider.
 *
 * @module
 */
import { Probe, probingHost } from "@melian-agent/pipeline";
import { liveModels } from "./credentials.ts";
import { buildGraph, graphCached, runRange } from "./goldens.ts";
import { checkoutCommit, measureParity } from "./parity.ts";

if (process.env.MELIAN_EVAL_LIVE !== "1") {
	console.error("Live evals call real models and spend tokens. Set MELIAN_EVAL_LIVE=1 to run them.");
	process.exit(2);
}

process.exit(
	await measureParity(
		process.env,
		{
			availability: () => Probe.availability(),
			models: () => liveModels(process.cwd()),
			range: runRange,
			graph: (target) => buildGraph(target),
			graphCached,
			commit: (artefacts) => checkoutCommit(import.meta.dirname, artefacts),
			host: () => probingHost(Probe.sandbox),
		},
		console.log,
		console.error,
	),
);
