import { writeFileSync } from "node:fs";
import { visibleText } from "@melian-agent/core";
import type { ReviewModels, StageTelemetry } from "@melian-agent/pipeline";
import { type Golden, type GoldenRun, type GoldenScore, scoreCorpus, scoreGolden } from "./goldens.ts";
import { GoldenRunError } from "./run-error.ts";
import { runTriageGolden, type TriageChosen, type TriageGolden, TriageResults } from "./triage.ts";
import { scoreVerifierGolden, type VerifierGolden, type VerifierRun } from "./verifier.ts";

type Print = (line: string) => void;
type VerifierScore = ReturnType<typeof scoreVerifierGolden>;

// A score says a golden failed; these say which finding a lens reported, or why the verifier left a claim unjudged.
export function verdictLabel(verdict: string | undefined, unjudged: string | undefined): string {
	return verdict ?? `unjudged (${unjudged ?? "no reason recorded"})`;
}

export function shownOutput(rendered: string, env: NodeJS.ProcessEnv): string[] {
	if (env.MELIAN_EVAL_SHOW !== "1") return [];
	return rendered
		.trimEnd()
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`));
}

// A run that throws, as a review does when every model of a tier fails, prints its error on the golden's line and the
// corpus goes on; uncaught, it ended the process with a stack trace and no score.
async function attempt<Run>(name: string, run: () => Promise<Run>, print: Print): Promise<Run | undefined> {
	try {
		return await run();
	} catch (error) {
		print(
			visibleText(
				`${name}: no score (${error instanceof Error ? error.message : String(error)})${error instanceof GoldenRunError ? `, ${error.telemetry.spend()}` : ""}`,
			),
		);
		return undefined;
	}
}

export async function reportGoldens(
	goldens: readonly Golden[],
	run: (golden: Golden) => Promise<GoldenRun>,
	env: NodeJS.ProcessEnv,
	print: Print,
): Promise<{ scores: GoldenScore[]; failed: string[]; status: 0 | 1 }> {
	const scores: GoldenScore[] = [];
	const failed: string[] = [];
	for (const golden of goldens) {
		if (!golden.live) {
			print(visibleText(`${golden.name}: skipped, live: false`));
			continue;
		}
		const ran = await attempt(golden.name, () => run(golden), print);
		if (ran === undefined) {
			failed.push(golden.name);
			continue;
		}
		const score = scoreGolden(golden, ran.findings);
		scores.push(score);
		print(
			visibleText(
				`${golden.name}: precision ${score.precision.toFixed(2)}, recall ${score.recall.toFixed(2)} (${score.reported} reported, ${score.expected} expected), ${ran.telemetry.spend()}`,
			),
		);
		for (const line of shownOutput(ran.rendered, env)) print(line);
	}
	const corpus = scoreCorpus(scores);
	print(`corpus: precision ${corpus.precision.toFixed(2)}, recall ${corpus.recall.toFixed(2)}`);
	return { scores, failed, status: failed.length > 0 ? 1 : 0 };
}

export async function reportVerifierGoldens(
	goldens: readonly VerifierGolden[],
	run: (golden: VerifierGolden) => Promise<VerifierRun>,
	env: NodeJS.ProcessEnv,
	print: Print,
): Promise<{ scores: VerifierScore[]; failed: string[]; status: 0 | 1 }> {
	const scores: VerifierScore[] = [];
	const failed: string[] = [];
	for (const golden of goldens) {
		const ran = await attempt(golden.name, () => run(golden), print);
		if (ran === undefined) {
			failed.push(golden.name);
			continue;
		}
		const score = scoreVerifierGolden(golden, ran);
		scores.push(score);
		print(
			visibleText(
				`${golden.name}: ${verdictLabel(score.verdict, ran.unjudged)}, ${score.passed ? "passed" : "failed"} (${score.kind}), ${ran.telemetry.spend()}`,
			),
		);
		for (const line of shownOutput(ran.rendered, env)) print(line);
	}
	print(`verifier corpus: ${scores.filter((score) => score.passed).length}/${scores.length} passed`);
	return { scores, failed, status: failed.length === 0 && scores.every((score) => score.passed) ? 0 : 1 };
}

export async function measureTriageGoldens(
	goldens: readonly TriageGolden[],
	run: (golden: TriageGolden, record: (telemetry: StageTelemetry) => void) => Promise<TriageChosen[]>,
	print: Print,
): Promise<{ chosen: Record<string, TriageChosen[]>; telemetry: Record<string, StageTelemetry[]>; failed?: string }> {
	const chosen: Record<string, TriageChosen[]> = {};
	const telemetry: Record<string, StageTelemetry[]> = {};
	for (const golden of goldens) {
		telemetry[golden.name] = [];
		try {
			chosen[golden.name] = await run(golden, (record) => {
				telemetry[golden.name]!.push(record);
			});
		} catch (error) {
			if (error instanceof GoldenRunError) telemetry[golden.name]!.push(error.telemetry);
			for (const [name, passes] of Object.entries(telemetry)) {
				for (const [index, pass] of passes.entries())
					print(visibleText(`${name}: pass ${index + 1}, ${pass.spend()}`));
			}
			print(visibleText(`${golden.name}: no score (${error instanceof Error ? error.message : String(error)})`));
			return { chosen, telemetry, failed: golden.name };
		}
	}
	return { chosen, telemetry };
}

export async function reportTriageGoldens(
	goldens: readonly TriageGolden[],
	models: ReviewModels,
	model: string,
	passes: number,
	fingerprint: string,
	print: Print,
	printError: Print,
	out?: string,
): Promise<TriageResults> {
	const { chosen, telemetry, failed } = await measureTriageGoldens(
		goldens,
		(golden, record) => runTriageGolden(golden, { kind: "live", models, model }, passes, record),
		printError,
	);
	const results = TriageResults.measure(goldens, chosen, { model, fingerprint, telemetry });
	if (out !== undefined && out !== "") writeFileSync(out, `${JSON.stringify(results.toJSON(), null, 2)}\n`);
	if (failed !== undefined) throw new Error(`${visibleText(failed)}: triage measurement failed`);
	print(
		results
			.render()
			.split("\n")
			.map((line) => visibleText(line))
			.join("\n"),
	);
	return results;
}
