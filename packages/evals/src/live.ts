/**
 * Runs every golden against real models and prints precision and recall. Spends real tokens, so it runs only with
 * `MELIAN_EVAL_LIVE=1`, and never in `npm run check`. `MELIAN_EVAL_MODEL`, as `provider/model-id`, routes every tier a
 * golden's `melian.yaml` leaves unrouted. `MELIAN_EVAL_GOLDEN` names one golden to run instead of all of them. Credentials
 * come from Pi's login or the providers' environment variables. A golden whose `expected.json` sets `live: false` is
 * skipped and left out of the corpus score.
 *
 * @module
 */
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

let goldens: Golden[];
try {
	goldens = selectGoldens(loadGoldens(), process.env.MELIAN_EVAL_GOLDEN);
} catch (error) {
	console.error((error as Error).message);
	process.exit(2);
}
const models = createReviewModels();
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
