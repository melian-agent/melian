import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { CheckError } from "./errors.ts";
import type { ToolLog, ToolResult } from "./static.ts";

const position = Type.Object({ line: Type.Integer({ minimum: 1 }), column: Type.Integer({ minimum: 0 }) });
const mutant = Type.Object({
	mutatorName: Type.String(),
	replacement: Type.Optional(Type.String()),
	status: Type.String(),
	location: Type.Object({ start: position, end: position }),
});
const report = Type.Object({ files: Type.Record(Type.String(), Type.Object({ mutants: Type.Array(mutant) })) });

// Survived and NoCoverage are findings. These are set aside with a note: a mutant that hangs, or breaks the build or the
// run, shows the mutated code behaves differently, but no test said so by name.
const setAside: ReadonlySet<string> = new Set(["Timeout", "RuntimeError", "CompileError"]);
// The states a finished run leaves a mutant in. Anything else, such as Pending, means it did not judge every mutant.
const known: ReadonlySet<string> = new Set(["Killed", "Ignored", "Survived", "NoCoverage", ...setAside]);

const longestCode = 160;

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
	for (const [path, file] of Object.entries(files)) {
		const ranges = Object.hasOwn(run.lines, path) ? run.lines[path]! : undefined;
		if (ranges === undefined) continue;
		for (const each of file.mutants) {
			const { start, end } = each.location;
			if (!ranges.some(([first, last]) => start.line >= first && start.line <= last)) continue;
			if (setAside.has(each.status)) {
				aside.set(each.status, (aside.get(each.status) ?? 0) + 1);
				continue;
			}
			if (each.status === "Killed" || each.status === "Ignored") continue;
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
	return {
		log: { version: "2.1.0", runs: [{ tool: { driver: { name: "Stryker", version: run.version } }, results }] },
		notes,
	};
}
