import { type Golden, type GoldenRun, type GoldenScore, scoreGolden } from "./goldens.ts";
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
		print(`${name}: no score (${error instanceof Error ? error.message : String(error)})`);
		return undefined;
	}
}

export async function reportGoldens(
	goldens: readonly Golden[],
	run: (golden: Golden) => Promise<GoldenRun>,
	env: NodeJS.ProcessEnv,
	print: Print,
): Promise<{ scores: GoldenScore[]; failed: string[] }> {
	const scores: GoldenScore[] = [];
	const failed: string[] = [];
	for (const golden of goldens) {
		if (!golden.live) {
			print(`${golden.name}: skipped, live: false`);
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
			`${golden.name}: precision ${score.precision.toFixed(2)}, recall ${score.recall.toFixed(2)} (${score.reported} reported, ${score.expected} expected)`,
		);
		for (const line of shownOutput(ran.rendered, env)) print(line);
	}
	return { scores, failed };
}

export async function reportVerifierGoldens(
	goldens: readonly VerifierGolden[],
	run: (golden: VerifierGolden) => Promise<VerifierRun>,
	env: NodeJS.ProcessEnv,
	print: Print,
): Promise<{ scores: VerifierScore[]; failed: string[] }> {
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
			`${golden.name}: ${verdictLabel(score.verdict, ran.unjudged)}, ${score.passed ? "passed" : "failed"} (${score.kind})`,
		);
		for (const line of shownOutput(ran.rendered, env)) print(line);
	}
	return { scores, failed };
}
