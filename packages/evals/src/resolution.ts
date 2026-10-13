import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Adjudication,
	Changeset,
	causeSchema,
	evaluateGuardrails,
	Finding,
	Rendering,
	type RepositorySource,
	resolutionOverrides,
	resolutionSchema,
	severitySchema,
	type Verdict,
} from "@melian-agent/core";
import { configsFor } from "@melian-agent/pipeline";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { copyTree, goldensDirectory, resolutionGoldens } from "./goldens.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });

/**
 * The JSON Schema of a resolution golden's `scenario.json`. `findings` are the reports a review would hold, scripted:
 * each names its check, rule, severity, and place, the verifier's `verdict` on a lens report, and a `lowered` severity
 * when the verifier lowered it. Two reports at one file, line, and code are one defect. The guardrails run over the
 * golden's change, and their findings join the scripted ones. `expect` says what each finding must resolve to: it
 * names the finding by its file and, where two share it, by the rule that speaks or the line; `decidedBy` is the file
 * that must have decided, empty when none spoke. `doctor` lists the lines `melian doctor` must print for the base's
 * policy.
 */
export const resolutionScenarioSchema = Type.Object(
	{
		title: text,
		findings: Type.Array(
			Type.Object(
				{
					check: text,
					rule: text,
					severity: severitySchema,
					file: text,
					line: Type.Optional(Type.Integer({ minimum: 1 })),
					code: Type.Optional(text),
					cause: Type.Optional(causeSchema),
					verdict: Type.Optional(
						Type.Union([Type.Literal("confirmed"), Type.Literal("plausible"), Type.Literal("refuted")]),
					),
					lowered: Type.Optional(Type.Object({ to: severitySchema, reason: text }, strict)),
				},
				strict,
			),
		),
		expect: Type.Array(
			Type.Object(
				{
					file: text,
					rule: Type.Optional(text),
					line: Type.Optional(Type.Integer({ minimum: 1 })),
					resolution: resolutionSchema,
					decidedBy: Type.Optional(Type.String()),
				},
				strict,
			),
			{ minItems: 1 },
		),
		doctor: Type.Array(text),
	},
	strict,
);

/** A resolution golden's `scenario.json`. */
export type ResolutionScenario = Static<typeof resolutionScenarioSchema>;

/**
 * One resolution golden: a `base/` tree holding the policy, an optional `head/` tree laid over it as the change, and
 * the scripted findings to resolve under the base's policy, with no model.
 */
export interface ResolutionGolden {
	readonly name: string;
	readonly directory: string;
	readonly scenario: ResolutionScenario;
}

/** What a resolution golden's run decided: the verdict, its terminal rendering, and the lines `melian doctor` prints. */
export interface ResolutionRun {
	readonly verdict: Verdict;
	readonly rendered: string;
	readonly doctor: readonly string[];
}

/** Where the resolution goldens live: one directory per golden. */
export const resolutionDirectory = join(goldensDirectory, resolutionGoldens);

/** Loads every resolution golden under `directory`, in name order. */
export function loadResolutionGoldens(directory: string = resolutionDirectory): ResolutionGolden[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const file = join(directory, name, "scenario.json");
			const scenario: unknown = JSON.parse(readFileSync(file, "utf8"));
			const error = [...Value.Errors(resolutionScenarioSchema, scenario)][0];
			if (error !== undefined) throw new Error(`${file}: ${error.instancePath || "(top level)"} ${error.message}`);
			return { name, directory: join(directory, name), scenario: scenario as ResolutionScenario };
		});
}

const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Melian Evals",
	GIT_AUTHOR_EMAIL: "evals@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Evals",
	GIT_COMMITTER_EMAIL: "evals@melian.invalid",
};

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();
}

const explanation = { what: "Scripted.", whyHere: "Scripted.", whatToDo: "Scripted." };

// A scripted report as its check would store it, judged by the verifier where the scenario says so.
function reportOf(report: ResolutionScenario["findings"][number]): Finding {
	const {
		check,
		rule,
		severity,
		file,
		line = 1,
		code = "flagged();",
		cause = "introduced",
		verdict,
		lowered,
	} = report;
	const finding = Finding.create({
		rule,
		message: `${rule}, as ${check} reports it.`,
		file,
		startLine: line,
		snippet: code,
		occurrence: 0,
		cause,
		severity,
		explanation,
		source: { check, version: "scripted" },
		// Only a lens states a failure scenario; a static or guardrail report has none.
		...(check.startsWith("lens.") ? { failureScenario: "Scripted." } : {}),
	});
	if (verdict === undefined) return finding;
	return finding.verifiedAs({
		verdict,
		reason: "The scripted verifier judged the claim.",
		executor: "llm",
		model: "scripted/judge",
		version: "scripted",
		...(lowered === undefined ? {} : { lowered: { from: severity, to: lowered.to, reason: lowered.reason } }),
	});
}

/**
 * Resolves a golden's scripted findings the way a review of a pull request does: policy and lenses from the base
 * commit, each finding under its own path's layers and its lens's declared default, merged and adjudicated by core.
 * No model runs. The rendering is what `melian findings` prints, naming the file and entry that decided each finding.
 */
export async function runResolutionGolden(golden: ResolutionGolden): Promise<ResolutionRun> {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), `melian-resolution-${golden.name}-`)));
	try {
		git(repo, "init", "--quiet", "--initial-branch=main");
		copyTree(join(golden.directory, "base"), repo);
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "--allow-empty", "-m", "base");
		const base = git(repo, "rev-parse", "HEAD");
		git(repo, "checkout", "--quiet", "-b", "feature");
		if (existsSync(join(golden.directory, "head"))) copyTree(join(golden.directory, "head"), repo);
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "--allow-empty", "-m", "head");
		const source: RepositorySource = { kind: "revision", commit: base };
		const { revision } = await Changeset.resolve(repo, "main...feature");
		// The guardrails judge the change, so a golden with no `head/` tree gets no finding from them.
		const guardrails = await evaluateGuardrails({ repoRoot: repo, revision, source });
		const findings = [...golden.scenario.findings.map(reportOf), ...guardrails.findings];
		const config = await configsFor(repo, source, findings);
		const verdict = new Adjudication({
			findings,
			manifest: [],
			checks: [],
			config,
			verificationRan: true,
		}).adjudicate();
		const doctor = await resolutionOverrides(repo, source);
		return { verdict, rendered: verdict.render(new Rendering({ all: true, decided: true })), doctor };
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}
