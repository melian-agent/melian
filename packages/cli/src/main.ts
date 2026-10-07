import { parseArgs } from "node:util";
import { dismissalReason, FindingError, visibleText } from "@melian-agent/core";
import { dismiss, findings, type Io, publish, review, reviewExitCodes } from "./commands.ts";
import { compare, matchByHand, parseImportSource } from "./compare.ts";
import { doctor } from "./doctor.ts";
import { parseTarget } from "./target.ts";
import { tools } from "./tools.ts";

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
  tools [fetch <name>]   List pinned tool readiness, or fetch and verify one tool. Exits 0 success, 1 failure.
  doctor                 Check Node, git, credentials, model routes, tool readiness, and GitHub access.

Options:
  --model <provider/id>  Route every tier to this model, over any route melian.yaml sets (review).
  --rerun                Run again the checks and lenses that failed in the last review of this base and head,
                         and ask triage again if its decision did not complete, rather than print what it
                         stored; a completed triage decision is never asked again (review).
  --open, --all, --json  For findings.
  --reason <text>        Why the finding does not apply, at most 1000 characters (dismiss).
  --only                 Dismiss the report the ID names alone, leaving the reports merged with it live (dismiss).
  --from <source>        Where to import external findings from; repeat it for several (compare).
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
			case "tools":
				if (rest.length === 0) return await tools(scoped);
				if (rest.length === 2 && rest[0] === "fetch") return await tools(scoped, rest[1]!);
				throw new UsageError("tools takes no arguments or fetch <name>");
			default:
				throw new UsageError(`unknown command ${name}`);
		}
	} catch (error) {
		const usageError = error instanceof UsageError || String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS");
		// A message can quote what a repository, a reviewer's file, or GitHub supplied, so it prints as visible text.
		io.stderr(`melian: ${visibleText(error instanceof Error ? error.message : String(error))}\n`);
		if (usageError) {
			io.stderr("Run melian --help for usage.\n");
			return usageExitCode;
		}
		return command === "review" ? reviewExitCodes.notReviewed : 1;
	}
}
