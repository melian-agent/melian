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
import { createReviewModels } from "@melian-agent/pipeline";
import { liveCredentials } from "./credentials.ts";
import {
	type Golden,
	type GoldenScore,
	loadGoldens,
	runGolden,
	scoreCorpus,
	scoreGolden,
	selectGoldens,
} from "./goldens.ts";
import { loadVerifierGoldens, runVerifierGolden, scoreVerifierGolden } from "./verifier.ts";

if (process.env.MELIAN_EVAL_LIVE !== "1") {
	console.error("Live evals call real models and spend tokens. Set MELIAN_EVAL_LIVE=1 to run them.");
	process.exit(2);
}

const verifierModel = process.env.MELIAN_EVAL_VERIFIER_MODEL;
if (process.env.MELIAN_EVAL_VERIFIER === "1") {
	const all = loadVerifierGoldens();
	const selected = process.env.MELIAN_EVAL_GOLDEN;
	const goldens = selected === undefined || selected === "" ? all : all.filter((golden) => golden.name === selected);
	if (goldens.length === 0 || (verifierModel ?? process.env.MELIAN_EVAL_MODEL) === undefined) {
		console.error("Verifier evals need a known golden and MELIAN_EVAL_VERIFIER_MODEL or MELIAN_EVAL_MODEL.");
		process.exit(2);
	}
	const models = createReviewModels({ credentials: await liveCredentials(process.cwd()) });
	const scores = [];
	for (const golden of goldens) {
		const run = await runVerifierGolden(golden, {
			kind: "live",
			models,
			model: process.env.MELIAN_EVAL_MODEL,
			verifierModel,
		});
		const score = scoreVerifierGolden(golden, run);
		scores.push(score);
		console.log(
			`${golden.name}: ${score.verdict ?? "unjudged"}, ${score.passed ? "passed" : "failed"} (${score.kind})`,
		);
	}
	console.log(`verifier corpus: ${scores.filter((score) => score.passed).length}/${scores.length} passed`);
	process.exit(scores.every((score) => score.passed) ? 0 : 1);
}

const allGoldens = loadGoldens();
let goldens: Golden[];
try {
	goldens = selectGoldens(allGoldens, process.env.MELIAN_EVAL_GOLDEN);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}
const models = createReviewModels({ credentials: await liveCredentials(process.cwd()) });
const model = process.env.MELIAN_EVAL_MODEL;
const scores: GoldenScore[] = [];
for (const golden of goldens) {
	if (!golden.live) {
		console.log(`${golden.name}: skipped, live: false`);
		continue;
	}
	const run = await runGolden(golden, {
		kind: "live",
		models,
		...(model === undefined ? {} : { model }),
		...(verifierModel === undefined ? {} : { verifierModel }),
	});
	const score = scoreGolden(golden, run.findings);
	scores.push(score);
	console.log(
		`${golden.name}: precision ${score.precision.toFixed(2)}, recall ${score.recall.toFixed(2)} (${score.reported} reported, ${score.expected} expected)`,
	);
}
const corpus = scoreCorpus(scores);
console.log(`corpus: precision ${corpus.precision.toFixed(2)}, recall ${corpus.recall.toFixed(2)}`);
