/**
 * Runs every golden against real models and prints precision and recall. Spends real tokens, so it runs only with
 * `MELIAN_EVAL_LIVE=1`, and never in `npm run check`. `MELIAN_EVAL_MODEL`, as `provider/model-id`, routes every tier a
 * golden's `melian.golden.yaml` leaves unrouted. `MELIAN_EVAL_GOLDEN` names one golden to run instead of all of them.
 * Credentials resolve as in a review: the named credentials of the secrets files, the per-clone one of the working
 * directory's repository and the user's own, then Pi's login, then the providers' environment variables. A golden whose `expected.json` sets
 * `live: false` is skipped and left out of the corpus score. `MELIAN_EVAL_TRIAGE=1` runs the triage corpus instead:
 * the fallback decider on `MELIAN_EVAL_MODEL` chooses each lens's level `MELIAN_EVAL_TRIAGE_PASSES` times (three by
 * default), the measurement prints, `MELIAN_EVAL_TRIAGE_OUT` writes it as JSON, and `MELIAN_EVAL_TRIAGE_BASELINE`
 * names an earlier measurement to compare, exiting 1 when the questions choose worse. `MELIAN_EVAL_SHOW=1` prints each
 * golden's rendered review under its score, for a lens or a verifier golden. A golden whose run throws prints
 * `no score` with the error, the rest still run, and the script exits 1.
 *
 * @module
 */
import { readFileSync } from "node:fs";
import { liveModels } from "./credentials.ts";
import { type Golden, loadGoldens, runGolden, selectGoldens } from "./goldens.ts";
import { reportGoldens, reportTriageGoldens, reportVerifierGoldens } from "./live-output.ts";
import { loadTriageGoldens, TriageQuestions, TriageResults } from "./triage.ts";
import { loadVerifierGoldens, runVerifierGolden } from "./verifier.ts";

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
	const models = await liveModels(process.cwd());
	const verifier = await reportVerifierGoldens(
		goldens,
		(golden) =>
			runVerifierGolden(golden, { kind: "live", models, model: process.env.MELIAN_EVAL_MODEL, verifierModel }),
		process.env,
		console.log,
	);
	process.exit(verifier.status);
}

if (process.env.MELIAN_EVAL_TRIAGE === "1") {
	const model = process.env.MELIAN_EVAL_MODEL;
	const all = loadTriageGoldens();
	const selected = process.env.MELIAN_EVAL_GOLDEN;
	const goldens = selected === undefined || selected === "" ? all : all.filter((golden) => golden.name === selected);
	const passes = Number(process.env.MELIAN_EVAL_TRIAGE_PASSES ?? "3");
	if (goldens.length === 0 || model === undefined || !Number.isInteger(passes) || passes < 1) {
		console.error("Triage evals need a known golden, MELIAN_EVAL_MODEL, and MELIAN_EVAL_TRIAGE_PASSES of 1 or more.");
		process.exit(2);
	}
	const models = await liveModels(process.cwd());
	const results = await reportTriageGoldens(
		goldens,
		models,
		model,
		passes,
		(await TriageQuestions.shipped(all[0]!)).fingerprint(),
		console.log,
		console.error,
		process.env.MELIAN_EVAL_TRIAGE_OUT,
	);
	const baseline = process.env.MELIAN_EVAL_TRIAGE_BASELINE;
	if (baseline === undefined || baseline === "") process.exit(0);
	const compared = results.compare(TriageResults.parse(readFileSync(baseline, "utf8")));
	console.log(`${compared.verdict}: ${compared.lines.join("; ")}`);
	process.exit(compared.verdict === "worse" ? 1 : compared.verdict === "incomparable" ? 2 : 0);
}

const allGoldens = loadGoldens();
let goldens: Golden[];
try {
	goldens = selectGoldens(allGoldens, process.env.MELIAN_EVAL_GOLDEN);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}
const models = await liveModels(process.cwd());
const model = process.env.MELIAN_EVAL_MODEL;
const lens = await reportGoldens(
	goldens,
	(golden) =>
		runGolden(golden, {
			kind: "live",
			models,
			...(model === undefined ? {} : { model }),
			...(verifierModel === undefined ? {} : { verifierModel }),
		}),
	process.env,
	console.log,
);
process.exit(lens.status);
