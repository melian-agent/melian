import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Timeline } from "./timeline.mjs";

const usage = () => {
	console.error("usage: node scripts/pr-timeline.mjs <number> [--repo owner/name] [--record file.json]");
	process.exit(2);
};
let parsed;
try {
	parsed = parseArgs({ allowPositionals: true, options: { repo: { type: "string" }, record: { type: "string" } } });
} catch {
	usage();
}
const { positionals, values } = parsed;
if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) usage();
const requests = [];
const gh = (args) => {
	const stdout = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	requests.push({ args, stdout });
	return stdout;
};
const timeline = Timeline.fetch({ number: Number(positionals[0]), repo: values.repo ?? "melian-agent/melian", gh });
if (values.record) writeFileSync(values.record, `${JSON.stringify(requests, null, "\t")}\n`);
console.log(timeline.render());
