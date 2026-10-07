import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { CheckError } from "./errors.ts";
import type { ToolLog, ToolResult } from "./static.ts";

const position = Type.Object({ line: Type.Integer({ minimum: 1 }), column: Type.Integer({ minimum: 0 }) });
const mutant = Type.Object({
	mutatorName: Type.String(),
	replacement: Type.Optional(Type.String()),
	status: Type.String(),
	statusReason: Type.Optional(Type.String()),
	location: Type.Object({ start: position, end: position }),
});
const report = Type.Object({ files: Type.Record(Type.String(), Type.Object({ mutants: Type.Array(mutant) })) });

// Survived and NoCoverage are findings. These are set aside with a note: a mutant that hangs, or breaks the build or the
// run, shows the mutated code behaves differently, but no test said so by name.
const setAside: ReadonlySet<string> = new Set(["Timeout", "RuntimeError", "CompileError"]);
// The states a finished run leaves a mutant in. Anything else, such as Pending, means it did not judge every mutant.
const known: ReadonlySet<string> = new Set(["Killed", "Ignored", "Survived", "NoCoverage", ...setAside]);

// The reasons Stryker 10.0.0 gives for a mutant that the `ignoreStatic` setting or the `excludedMutations` setting ignores
// (core's mutant-test-planner and instrumenter's babel-transformer). Any other reason, such as the one a `// Stryker
// disable` comment gives, or none, is the head's own text choosing what the judge skips.
const staticReason = 'Static mutant (and "ignoreStatic" was enabled)';
const excludedReason = /^Ignored because of excluded mutation ".*"$/;

function ignoredByConfiguration(reason: string | undefined): boolean {
	return reason === staticReason || excludedReason.test(String(reason));
}

const longestCode = 160;

/**
 * The reasons `static.mutation` records a skip that does not stop a review. The check is advisory in nature, so a change
 * it cannot judge, or may not run on, still lets the review finish; the reason stays in the record. Any other skip, such
 * as a disabled check or a checkout without Stryker, leaves the review not reviewed.
 */
export const mutationSkips = {
	noProductionLines: "the change adds or edits no production TypeScript lines",
	untrustedWriter: (detail: string) =>
		`the writer is not a trusted one (${detail}), so Stryker did not run: static.mutation executes the head's own tests`,
	timeout: (seconds: number) => `Stryker ran past static.mutation.timeout of ${seconds} seconds before it finished`,
};

const leaveReasons: readonly RegExp[] = [
	/^the change adds or edits no production TypeScript lines$/,
	/^the writer is not a trusted one\b/,
	/^Stryker ran past static\.mutation\.timeout of \d+ seconds before it finished$/,
];

/** Whether a `static.mutation` skip with this reason lets a review pass: a change with nothing to mutate, or too slow, or from a writer Melian does not trust to run code. */
export function mutationSkipHasLeave(reason: string | undefined): boolean {
	return leaveReasons.some((pattern) => pattern.test(String(reason)));
}

/** What {@link normaliseMutationReport} reads a Stryker report against. */
export interface MutationReportInput {
	/** The Stryker version that wrote the report. */
	readonly version: string;
	/**
	 * The lines the change adds or edits at head, by repository-relative path: inclusive `[first, last]` ranges. A mutant
	 * on any other line, or in any other file, is not the change's to answer for.
	 */
	readonly lines: Readonly<Record<string, readonly (readonly [number, number])[]>>;
	/** The test file nearest each path in `lines`, which a finding names as where to add the test. */
	readonly tests: Readonly<Record<string, string>>;
}

function code(replacement: string | undefined): string {
	if (replacement === undefined) return "something else";
	const text = replacement.replace(/\s+/g, " ").trim().replaceAll("`", "'");
	return `\`${text.length > longestCode ? `${text.slice(0, longestCode)}...` : text}\``;
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function invalid(detail: string, cause?: unknown): CheckError {
	return new CheckError("invalidOutput", "static.mutation", `Stryker wrote a report Melian cannot read: ${detail}`, {
		cause,
	});
}

/**
 * Reads Stryker's JSON mutation report into a tool log of one result per mutant that no test caught on a changed line.
 * A `Survived` mutant ran against tests that all passed; a `NoCoverage` mutant sits in code no test runs. `Timeout`,
 * `RuntimeError`, and `CompileError` mutants come back as notes. Throws `CheckError` `invalidOutput` when the text is
 * not a report, or names a mutant status Stryker does not end a run with.
 */
export function normaliseMutationReport(text: string, run: MutationReportInput): { log: ToolLog; notes: string[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw invalid("it is not JSON", cause);
	}
	const problem = Value.Errors(report, parsed)[0];
	if (problem !== undefined) throw invalid(`${problem.instancePath} ${problem.message}`);
	const { files } = parsed as Static<typeof report>;
	for (const file of Object.values(files))
		for (const each of file.mutants)
			if (!known.has(each.status)) throw invalid(`mutant status ${each.status} is not one Stryker ends a run with`);
	const results: ToolResult[] = [];
	const aside = new Map<string, number>();
	const ignored = new Map<string, Map<number, string>>();
	const configured = new Map<string, Set<number>>();
	const mutated = new Set<string>();
	for (const [path, file] of Object.entries(files)) {
		if (file.mutants.length > 0) mutated.add(path);
		const ranges = Object.hasOwn(run.lines, path) ? run.lines[path]! : undefined;
		if (ranges === undefined) continue;
		for (const each of file.mutants) {
			const { start, end } = each.location;
			if (!ranges.some(([first, last]) => start.line >= first && start.line <= last)) continue;
			if (setAside.has(each.status)) {
				aside.set(each.status, (aside.get(each.status) ?? 0) + 1);
				continue;
			}
			if (each.status === "Ignored" && ignoredByConfiguration(each.statusReason)) {
				const lines = configured.get(path) ?? new Set<number>();
				lines.add(start.line);
				configured.set(path, lines);
				continue;
			}
			if (each.status === "Ignored") {
				const lines = ignored.get(path) ?? new Map<number, string>();
				if (!lines.has(start.line)) lines.set(start.line, each.statusReason ?? "Stryker gives no reason");
				ignored.set(path, lines);
				continue;
			}
			if (each.status === "Killed") continue;
			const survived = each.status === "Survived";
			const test = run.tests[path] ?? "a test file";
			results.push({
				ruleId: "untested-behaviour",
				level: "error",
				message: {
					text: survived
						? `${each.mutatorName} mutant survived: with this code changed to ${code(each.replacement)}, every test still passed.`
						: `${each.mutatorName} mutant has no test coverage: no test runs this code, so changing it to ${code(each.replacement)} fails nothing.`,
				},
				advice: {
					whyHere: survived
						? "A mutant of this changed line survived the test run, so no test fails when this behaviour changes."
						: "No test runs this changed line, so no test fails when this behaviour changes.",
					whatToDo: `Add or tighten a test in ${test} so it fails when this code is changed as the mutant changed it, then restore the code.`,
				},
				locations: [
					{
						physicalLocation: {
							artifactLocation: { uri: path.split("/").map(encodeURIComponent).join("/") },
							region:
								end.line > start.line
									? { startLine: start.line, endLine: end.line }
									: { startLine: start.line },
						},
					},
				],
			});
		}
	}
	// A comment, or any reason that is not a configuration setting, is the head's own text choosing what the judge skips, so
	// an ignored mutant is never read as caught: a maintainer acknowledges or dismisses it.
	for (const [path, lines] of ignored) {
		for (const [line, reason] of lines) {
			results.push({
				ruleId: "ignored-mutant",
				level: "error",
				message: {
					text: `Stryker ignored the mutants of this changed line, so no test was asked about them (${reason}).`,
				},
				advice: {
					whyHere:
						"The head's own text told Stryker not to judge this changed line, so a guard here would stay unproven.",
					whatToDo:
						"Remove the comment that excludes this line and test the behaviour, or acknowledge the exclusion if it is deliberate.",
				},
				locations: [
					{
						physicalLocation: {
							artifactLocation: { uri: path.split("/").map(encodeURIComponent).join("/") },
							region: { startLine: line },
						},
					},
				],
			});
		}
	}
	results.sort((a, b) => {
		const [left, right] = [a, b].map((result) => result.locations[0]!.physicalLocation);
		return (
			compare(left!.artifactLocation.uri, right!.artifactLocation.uri) ||
			left!.region.startLine - right!.region.startLine ||
			compare(a.message.text, b.message.text)
		);
	});
	const notes = [...aside].map(
		([status, count]) =>
			`${count} ${status} mutant(s) on changed lines were set aside: a hang or a crash is not a survivor, so no finding is raised for it.`,
	);
	// A static mutant, or one a setting in `stryker.config.*` excludes, is the configuration's trade-off, which is a policy
	// file a maintainer reads: a note names the lines.
	for (const [path, lines] of [...configured].sort(([a], [b]) => compare(a, b))) {
		const named = [...lines].sort((a, b) => a - b).join(", ");
		notes.push(
			`${path} line(s) ${named} hold mutants Stryker ignored by a setting in its configuration (static mutants, or an excluded mutation), so no test was asked about them.`,
		);
	}
	// A path in `--mutate` is a glob, so one that matches no file leaves a report that reads as clean.
	for (const path of Object.keys(run.lines)) {
		if (!mutated.has(path)) notes.push(`${path} produced no mutants, so nothing on its changed lines was judged.`);
	}
	return {
		log: { version: "2.1.0", runs: [{ tool: { driver: { name: "Stryker", version: run.version } }, results }] },
		notes,
	};
}
