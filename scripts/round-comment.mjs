// Writes the pull request comment for a round the melian-round workflow ran, or with --fence prints a file fenced for
// the job summary.
// Usage: node scripts/round-comment.mjs --verdict <file> --rounds <file> --exit <code> --run-url <url> --run-id <id> --base <sha>
//          --head <sha> --merge-base <sha> [--current-base <sha> --current-head <sha>]
//        A missing current base or head means the pull request could not be read again.
//        node scripts/round-comment.mjs --fence <file>
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { visibleText } from "../packages/core/src/render.ts";
import { fenced, RoundComment } from "./round.mjs";

// A step summary holds 1 MiB of UTF-8 and fences two files. A UTF-16 code unit is at most three bytes of UTF-8, so
// 170,000 of them fit twice.
const summaryBudget = 170_000;
const required = ["verdict", "rounds", "exit", "run-url", "run-id", "base", "head", "merge-base"];
const names = [...required, "current-base", "current-head"];

if (process.argv[2] === "--fence") {
	const path = process.argv[3];
	const text = existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
	process.stdout.write(
		text === "" ? "Nothing was written.\n" : fenced(text.split("\n").map(visibleText), summaryBudget),
	);
} else {
	let values;
	try {
		({ values } = parseArgs({ options: Object.fromEntries(names.map((name) => [name, { type: "string" }])) }));
	} catch {
		values = {};
	}
	if (required.some((name) => values[name] === undefined)) {
		process.stderr.write(
			`usage: node scripts/round-comment.mjs ${required.map((name) => `--${name} <value>`).join(" ")}\n`,
		);
		process.exit(64);
	}
	const current =
		values["current-head"] === undefined ? undefined : { base: values["current-base"], head: values["current-head"] };
	const comment = RoundComment.read({
		verdict: values.verdict,
		rounds: values.rounds,
		exitCode: values.exit,
		runUrl: values["run-url"],
		runId: values["run-id"],
		base: values.base,
		head: values.head,
		mergeBase: values["merge-base"],
		current,
	});
	process.stdout.write(comment.body());
}
