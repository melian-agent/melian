import { parseArgs } from "node:util";
import {
	ComparisonAdjudication,
	ComparisonError,
	dismissalReason,
	FindingError,
	type StoredComparisonAdjudication,
	visibleText,
} from "@melian-agent/core";
import { dismiss, findings, type Io, publish, review, reviewExitCodes } from "./commands.ts";
import {
	adjudicateComparison,
	compare,
	comparisonBacklog,
	comparisonStats,
	exportComparison,
	matchByHand,
	parseImportSource,
} from "./compare.ts";
import { doctor } from "./doctor.ts";
import { parseTarget } from "./target.ts";

/** The exit code for a command line Melian cannot read, as `sysexits.h` numbers it. */
export const usageExitCode = 64;

export const usage = `Usage: melian <command> [options]

Commands:
  review <range|#pr>     Review a git range, such as main or main...feature, or a pull request, such as "#12".
                         Exits 0 passed, 1 blocking findings, 2 not reviewed, 3 findings with none blocking.
  publish <#pr>          Post the stored review of the pull request's current head to GitHub.
  findings <range|#pr>   Print the stored review. --open prints only findings that need attention, --all silent and
                         dismissed findings too; --json prints JSON.
  dismiss <range|#pr> <id> --reason <text> [--only]
                         Dismiss a finding of the stored review, with a reason, and decide its verdict again. It
                         dismisses every report merged into the finding unless --only names one report alone.
                         Exits 0 when recorded, 1 when the review or the finding is not found, or when the
                         dismissal was recorded but the verdict could not be decided again.
  compare <range|#pr> [--from <source>]...
                         Import other reviewers' findings and match them against the stored review of the head,
                         by site. A source is github for CodeRabbit's review threads, github:<login> for another
                         login's, or file:<path> for a reviewer's JSON file. Without --from, a pull request
                         imports github, and a range matches again.
  compare match|unmatch <range|#pr> <external-id> <melian-id>
                         Match an external finding with a Melian finding by hand, or keep them apart.
  compare adjudicate <range|#pr> <finding-id> --verdict valid|noise|duplicate
                         Record a local judgement, with --severity, --reason, --golden, --rule, --note, and --of.
  compare stats [--since <date>|--last <n>]
                         Show recall, precision, pending findings, miss reasons, candidate checks, and drain due.
  compare backlog [--markdown]
                         List owed goldens by lens; --markdown prints BACKLOG.md's generated section.
  compare export <range|#pr> [--out <path>] [--json]
                         Write the local comparison record as markdown, or its whole document as JSON.
  doctor                 Check Node, git, credentials, model routes, and GitHub access.

Options:
  --model <provider/id>  Route every tier to this model, over any route melian.yaml sets (review).
  --rerun                Run again the checks and lenses that failed in the last review of this base and head,
                         and ask triage again if its decision did not complete, rather than print what it
                         stored; a completed triage decision is never asked again (review).
  --open, --all, --json  For findings.
  --reason <text>        Dismissal reason, or owned-missed, no-owner, needs-execution, out-of-scope (adjudicate).
  --only                 Dismiss the report the ID names alone, leaving the reports merged with it live (dismiss).
  --from <source>        Where to import external findings from; repeat it for several (compare).
  --verdict <value>     valid, noise, or duplicate (compare adjudicate).
  --severity <value>    P0, P1, P2, P3, or nit (compare adjudicate).
  --of <finding-id>    The finding duplicated (compare adjudicate).
  --golden <lens|none>  The lens owed a golden (compare adjudicate).
  --rule <tag>          Cluster repeated valid findings under this rule (compare adjudicate).
  --note <text>         Maintainer decision, at most 1000 characters (compare adjudicate).
  --since <date>        Comparisons recorded since this ISO date (compare stats).
  --last <n>            The last n changesets compared (compare stats).
  --markdown            Print BACKLOG.md's generated section (compare backlog).
  --out <path>          Write the export to this path (compare export).
  --no-walkthrough       Omit the walkthrough (review, publish).
  --no-color             Print without colour.
  -h, --help             Show this help.

Quote a pull request number: an unquoted # starts a comment in most shells.
`;

class UsageError extends Error {}

// A reason Melian refuses, blank or too long, is a command line it cannot read.
function readableReason(reason: string): string {
	try {
		return dismissalReason(reason);
	} catch (error) {
		if (error instanceof FindingError) throw new UsageError(error.message);
		throw error;
	}
}

function isCalendarDay(date: string): boolean {
	return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

function one(positionals: readonly string[], command: string, what: string): string {
	if (positionals.length !== 1) throw new UsageError(`${command} takes one ${what}`);
	return positionals[0]!;
}

/**
 * Runs the `melian` command line `args` and returns its exit code. Errors print to `io.stderr` as one line; a failed
 * review exits `2`, any other failed command `1`, and a command line Melian cannot read {@link usageExitCode}.
 */
export async function main(args: readonly string[], io: Io): Promise<number> {
	let command: string | undefined;
	try {
		const { values, positionals } = parseArgs({
			args: [...args],
			allowPositionals: true,
			options: {
				open: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				model: { type: "string" },
				walkthrough: { type: "boolean", default: true },
				rerun: { type: "boolean", default: false },
				all: { type: "boolean", default: false },
				reason: { type: "string" },
				verdict: { type: "string" },
				severity: { type: "string" },
				out: { type: "string" },
				since: { type: "string" },
				last: { type: "string" },
				markdown: { type: "boolean", default: false },
				golden: { type: "string" },
				of: { type: "string" },
				rule: { type: "string" },
				note: { type: "string" },
				only: { type: "boolean", default: false },
				from: { type: "string", multiple: true, default: [] },
				color: { type: "boolean", default: true },
				help: { type: "boolean", short: "h", default: false },
			},
			allowNegative: true,
		});
		const [name, ...rest] = positionals;
		command = name;
		if (values.help || name === "help") {
			io.stdout(usage);
			return 0;
		}
		if (name === undefined) {
			io.stderr(usage);
			return usageExitCode;
		}
		const scoped: Io = { ...io, color: io.color && values.color };
		switch (name) {
			case "review":
				return await review(scoped, one(rest, name, "range or pull request"), {
					...(values.model === undefined ? {} : { model: values.model }),
					rerun: values.rerun,
					walkthrough: values.walkthrough,
				});
			case "publish":
				return await publish(scoped, one(rest, name, "pull request"), { walkthrough: values.walkthrough });
			case "findings":
				if (values.open && values.all) throw new UsageError("findings takes --open or --all, not both");
				return await findings(scoped, one(rest, name, "range or pull request"), {
					open: values.open,
					all: values.all,
					json: values.json,
				});
			case "dismiss": {
				if (rest.length !== 2) throw new UsageError("dismiss takes a range or pull request and a finding ID");
				const [target, id] = rest as [string, string];
				if (!/^[0-9a-f]{16}$/.test(id)) {
					throw new UsageError(`${id} is not a finding ID; an ID is 16 hex digits, as melian findings prints it`);
				}
				if (values.reason === undefined) throw new UsageError("dismiss needs --reason <text>");
				return await dismiss(scoped, target, id, readableReason(values.reason), { only: values.only });
			}
			case "compare": {
				const [first, ...others] = rest;
				if (first === "export") {
					return await exportComparison(scoped, one(others, "compare export", "range or pull request"), {
						json: values.json,
						...(values.out === undefined ? {} : { out: values.out }),
					});
				}
				if (first === "stats") {
					if (others.length > 0) throw new UsageError("compare stats takes no target");
					if (values.since !== undefined && values.last !== undefined)
						throw new UsageError("compare stats takes --since or --last, not both");
					if (
						values.since !== undefined &&
						(!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(values.since) ||
							!Number.isFinite(Date.parse(values.since)) ||
							!isCalendarDay(values.since.slice(0, 10)))
					)
						throw new UsageError("--since takes an ISO date");
					if (
						values.last !== undefined &&
						(!/^[1-9]\d*$/.test(values.last) || !Number.isSafeInteger(Number(values.last)))
					)
						throw new UsageError("--last takes a positive integer");
					return await comparisonStats(scoped, {
						...(values.since === undefined ? {} : { since: values.since }),
						...(values.last === undefined ? {} : { last: Number(values.last) }),
					});
				}
				if (first === "backlog") {
					if (others.length > 0) throw new UsageError("compare backlog takes no target");
					return await comparisonBacklog(scoped, values.markdown);
				}
				if (first === "adjudicate") {
					if (others.length !== 2)
						throw new UsageError("compare adjudicate takes a range or pull request and a finding ID");
					const [target, id] = others as [string, string];
					if (!/^[0-9a-f]{16}$/.test(id)) throw new UsageError("a finding ID is 16 hex digits");
					let fields: StoredComparisonAdjudication;
					try {
						fields = ComparisonAdjudication.create({
							verdict: values.verdict,
							severity: values.severity,
							reason: values.reason,
							golden: values.golden,
							of: values.of,
							rule: values.rule,
							note: values.note,
							by: "CLI",
							at: new Date().toISOString(),
						}).toJSON();
					} catch (error) {
						if (error instanceof ComparisonError) throw new UsageError(error.message);
						throw error;
					}
					return await adjudicateComparison(scoped, target, id, fields);
				}
				if (first === "match" || first === "unmatch") {
					if (others.length !== 3) {
						throw new UsageError(
							`compare ${first} takes a range or pull request, an external ID, and a Melian ID`,
						);
					}
					const [target, external, melian] = others as [string, string, string];
					for (const id of [external, melian]) {
						if (!/^[0-9a-f]{16}$/.test(id)) {
							throw new UsageError(
								`${id} is not a finding ID; an ID is 16 hex digits, as melian compare prints it`,
							);
						}
					}
					return await matchByHand(scoped, target, { external, melian }, first === "match");
				}
				const target = one(rest, name, "range or pull request");
				const sources = values.from.map((value) => {
					const source = parseImportSource(value);
					if (source === undefined) {
						throw new UsageError(`--from takes github, github:<login>, or file:<path>, not ${value}`);
					}
					return source;
				});
				const pullRequest = parseTarget(target).kind === "pullRequest";
				if (sources.some((source) => source.kind === "github") && !pullRequest) {
					throw new UsageError(`--from github reads a pull request's threads; name it as "#12", not a range`);
				}
				const fallback = pullRequest && sources.length === 0 ? [parseImportSource("github")!] : [];
				return await compare(scoped, target, [...sources, ...fallback]);
			}
			case "doctor":
				if (rest.length > 0) throw new UsageError("doctor takes no arguments");
				return await doctor(scoped);
			default:
				throw new UsageError(`unknown command ${name}`);
		}
	} catch (error) {
		const usageError = error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
		// A message can quote what a repository, a reviewer's file, or GitHub supplied, so it prints as visible text.
		io.stderr(`melian: ${visibleText(error instanceof Error ? error.message : String(error))}\n`);
		if (usageError) {
			io.stderr("Run melian --help for usage.\n");
			return usageExitCode;
		}
		return command === "review" ? reviewExitCodes.notReviewed : 1;
	}
}
