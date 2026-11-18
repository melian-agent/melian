// Prints, for the melian-round workflow's log, each level `melian review --require-probes` failed because it could not
// probe: its check, level and cause, and the cause's fixed sentence. The log is public and a reason's text can name a
// path in the head, so only values from closed sets reach it, and a file holding anything else prints one fixed line.
// Usage: node --conditions=@melian-agent/source scripts/round-probe-gaps.mjs <file --probe-gaps wrote> [<public file>]
// With a public file, it also writes there the gaps it printed, as JSON, for the round's comment; it writes nothing there
// when it prints none.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { scrutinyLevels } from "../packages/core/src/lens.ts";
import { probeGapSentences } from "../packages/pipeline/src/review.ts";

export const unreadable =
	"melian: the round's probe gaps did not read as Melian writes them, so this log names no cause";

/** The gaps of a probe gaps file, each rebuilt from closed-set values alone, or undefined if any is not one. */
export function probeGaps(text) {
	let gaps;
	try {
		gaps = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(gaps)) return undefined;
	const read = [];
	for (const gap of gaps) {
		// A string, a number or a list has other keys, so only null needs its own test, since it has none to list.
		if (gap === null || Object.keys(gap).sort().join(" ") !== "cause check level") return undefined;
		const { check, level, cause } = gap;
		if (typeof check !== "string" || !/^lens\.[a-z0-9-]+$/.test(check)) return undefined;
		if (!scrutinyLevels.includes(level)) return undefined;
		if (typeof cause !== "string" || !Object.hasOwn(probeGapSentences, cause)) return undefined;
		read.push({ check, level, cause });
	}
	return read;
}

/** The log's lines for the text of a probe gaps file, or `unreadable` alone. */
export function probeGapLines(text) {
	const gaps = probeGaps(text);
	if (gaps === undefined) return [unreadable];
	return gaps.map(
		({ check, level, cause }) =>
			`melian: ${check} at ${level} could not probe here, ${cause}: ${probeGapSentences[cause]}`,
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	let text;
	try {
		text = readFileSync(process.argv[2], "utf8");
	} catch {
		text = undefined;
	}
	if (text === undefined)
		process.stdout.write("melian: the round wrote no probe gaps, so it ended before its lenses did\n");
	else {
		for (const line of probeGapLines(text)) process.stdout.write(`${line}\n`);
		const gaps = probeGaps(text);
		if (process.argv[3] !== undefined && gaps !== undefined && gaps.length > 0)
			writeFileSync(process.argv[3], `${JSON.stringify(gaps)}\n`, "utf8");
	}
}
