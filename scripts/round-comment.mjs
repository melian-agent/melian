// Writes the pull request comment for a round the melian-round workflow ran, or with --public prints the part of a
// verdict that may leave the job.
// Usage: node scripts/round-comment.mjs --verdict <file> --rounds <file> --exit <code> --run-url <url> --run-id <id> --nonce <hex> --base <sha>
//          --head <sha> --merge-base <sha> [--current-base <sha> --current-head <sha>]
//        A missing current base or head means the pull request could not be read again. With --status <pull request URL>
//        it prints the melian/review status to set, as JSON, or nothing when none may be set.
//        node scripts/round-comment.mjs --public <verdict file>
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { publicVerdict, RoundComment } from "./round.mjs";

const required = ["verdict", "rounds", "exit", "run-url", "run-id", "nonce", "base", "head", "merge-base"];
const names = [...required, "current-base", "current-head", "status"];

if (process.argv[2] === "--public") {
	let text;
	try {
		text = readFileSync(process.argv[3], "utf8");
	} catch {
		text = "";
	}
	process.stdout.write(`${JSON.stringify(publicVerdict(text))}\n`);
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
		nonce: values.nonce,
		base: values.base,
		head: values.head,
		mergeBase: values["merge-base"],
		current,
	});
	if (values.status === undefined) process.stdout.write(comment.body());
	else {
		const status = comment.status(values.status);
		if (status !== undefined) process.stdout.write(`${JSON.stringify(status)}\n`);
	}
}
