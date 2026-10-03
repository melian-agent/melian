import { parseArgs } from "node:util";
import { findings, type Io, publish, review, reviewExitCodes } from "./commands.ts";
import { doctor } from "./doctor.ts";

/** The exit code for a command line Melian cannot read, as `sysexits.h` numbers it. */
export const usageExitCode = 64;

export const usage = `Usage: melian <command> [options]

Commands:
  review <range|#pr>     Review a git range, such as main or main...feature, or a pull request, such as '#12'.
                         Exits 0 passed, 1 blocking findings, 2 not reviewed, 3 findings with none blocking.
  publish <#pr>          Post the stored review of the pull request's current head to GitHub.
  findings <range|#pr>   Print the stored review. --open prints only findings that need attention; --json prints JSON.
  doctor                 Check Node, git, credentials, model routes, and GitHub access.

Options:
  --model <provider/id>  Route every tier melian.yaml leaves unrouted to this model (review).
  --rerun                Run again the lenses that failed in the last review of this base and head, rather than
                         print the failure it stored (review).
  --open, --json         For findings.
  --no-color             Print without colour.
  -h, --help             Show this help.

Quote a pull request number: an unquoted # starts a comment in most shells.
`;

class UsageError extends Error {}

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
				rerun: { type: "boolean", default: false },
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
				});
			case "publish":
				return await publish(scoped, one(rest, name, "pull request"));
			case "findings":
				return await findings(scoped, one(rest, name, "range or pull request"), {
					open: values.open,
					json: values.json,
				});
			case "doctor":
				if (rest.length > 0) throw new UsageError("doctor takes no arguments");
				return await doctor(scoped);
			default:
				throw new UsageError(`unknown command ${name}`);
		}
	} catch (error) {
		const usageError = error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
		io.stderr(`melian: ${error instanceof Error ? error.message : String(error)}\n`);
		if (usageError) {
			io.stderr("Run melian --help for usage.\n");
			return usageExitCode;
		}
		return command === "review" ? reviewExitCodes.notReviewed : 1;
	}
}
