import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Timeline } from "./timeline.mjs";

const [number, ...flags] = process.argv.slice(2);
const option = (name) => {
	const at = flags.indexOf(name);
	return at === -1 ? undefined : flags[at + 1];
};
if (!/^\d+$/.test(number ?? "")) {
	console.error("usage: node scripts/pr-timeline.mjs <number> [--repo owner/name] [--record file.json]");
	process.exit(2);
}
const record = option("--record");
const requests = [];
const gh = (args) => {
	const stdout = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	requests.push({ args, stdout });
	return stdout;
};
const timeline = Timeline.fetch({ number: Number(number), repo: option("--repo") ?? "melian-agent/melian", gh });
if (record) writeFileSync(record, `${JSON.stringify(requests, null, "\t")}\n`);
console.log(timeline.render());
