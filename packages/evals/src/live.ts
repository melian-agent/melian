/**
 * Runs every golden against real models and prints precision and recall. Spends real tokens, so it runs only with
 * `MELIAN_EVAL_LIVE=1`, and never in `npm run check`. `MELIAN_EVAL_MODEL`, as `provider/model-id`, routes every tier a
 * golden's `melian.golden.yaml` leaves unrouted. `MELIAN_EVAL_GOLDEN` names one golden to run instead of all of them.
 * Credentials resolve as in a review: the named credentials of the secrets files, the per-clone one of the working
 * directory's repository and the user's own, then Pi's login, then the providers' environment variables. A golden whose `expected.json` sets
 * `live: false` is skipped and left out of the corpus score.
 *
 * @module
 */
import { loadSecrets, userFiles } from "@melian-agent/core";
import { createReviewModels } from "@melian-agent/pipeline";
import {
	type Golden,
	type GoldenScore,
	loadGoldens,
	runGolden,
	scoreCorpus,
	scoreGolden,
	selectGoldens,
} from "./goldens.ts";

if (process.env.MELIAN_EVAL_LIVE !== "1") {
	console.error("Live evals call real models and spend tokens. Set MELIAN_EVAL_LIVE=1 to run them.");
	process.exit(2);
}

const allGoldens = loadGoldens();
let goldens: Golden[];
try {
	goldens = selectGoldens(allGoldens, process.env.MELIAN_EVAL_GOLDEN);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}
const { credentials } = await loadSecrets(process.cwd(), userFiles().secrets);
const models = createReviewModels({ credentials });
const model = process.env.MELIAN_EVAL_MODEL;
const scores: GoldenScore[] = [];
for (const golden of goldens) {
	if (!golden.live) {
		console.log(`${golden.name}: skipped, live: false`);
		continue;
	}
	const run = await runGolden(golden, { kind: "live", models, ...(model === undefined ? {} : { model }) });
	const score = scoreGolden(golden, run.findings);
	scores.push(score);
	console.log(
		`${golden.name}: precision ${score.precision.toFixed(2)}, recall ${score.recall.toFixed(2)} (${score.reported} reported, ${score.expected} expected)`,
	);
}
const corpus = scoreCorpus(scores);
console.log(`corpus: precision ${corpus.precision.toFixed(2)}, recall ${corpus.recall.toFixed(2)}`);
