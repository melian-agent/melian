/**
 * Runs every golden against real models and prints precision and recall. Spends real tokens, so it runs only with
 * `MELIAN_EVAL_LIVE=1`, and never in `npm run check`. `MELIAN_EVAL_MODEL`, as `provider/model-id`, routes every tier a
 * golden's `melian.yaml` leaves unrouted. Credentials come from Pi's login or the providers' environment variables.
 *
 * @module
 */
import { createReviewModels } from "@melian-agent/pipeline";
import { type GoldenScore, loadGoldens, runGolden, scoreCorpus, scoreGolden } from "./goldens.ts";

if (process.env.MELIAN_EVAL_LIVE !== "1") {
	console.error("Live evals call real models and spend tokens. Set MELIAN_EVAL_LIVE=1 to run them.");
	process.exit(2);
}

const models = createReviewModels();
const model = process.env.MELIAN_EVAL_MODEL;
const scores: GoldenScore[] = [];
for (const golden of loadGoldens()) {
	const run = await runGolden(golden, { kind: "live", models, ...(model === undefined ? {} : { model }) });
	const score = scoreGolden(golden, run.findings);
	scores.push(score);
	console.log(
		`${golden.name}: precision ${score.precision.toFixed(2)}, recall ${score.recall.toFixed(2)} (${score.reported} reported, ${score.expected} expected)`,
	);
}
const corpus = scoreCorpus(scores);
console.log(`corpus: precision ${corpus.precision.toFixed(2)}, recall ${corpus.recall.toFixed(2)}`);
