import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { visibleText } from "../packages/core/src/render.ts";
import { SuiteExports } from "../packages/core/src/suite-exports.ts";
import { sampleMutants } from "./mutant-sample.mjs";

const defaultLimit = 200;

function jsonText(value) {
	return JSON.stringify(value, null, 2).split("\n").map(visibleText).join("\n");
}

export async function enumerateMutants({
	cwd = process.cwd(),
	range = "origin/main...HEAD",
	limit = defaultLimit,
} = {}) {
	if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit must be a non-negative safe integer");
	const cli = fileURLToPath(new URL("../packages/cli/bin/melian.js", import.meta.url));
	let output;
	try {
		output = execFileSync(process.execPath, [cli, "mutants", "list", range, "--json", "--limit", String(limit)], {
			cwd,
			encoding: "utf8",
			maxBuffer: 512 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (error.code === "ENOBUFS") throw new Error("compatibility output exceeds its 512 MiB buffer; reduce --limit");
		throw error;
	}
	const inventory = JSON.parse(output);
	return {
		mutants: inventory.mutants.map(({ id, ignoredBy, status, ...row }) => ({
			...row,
			...(status === "ignored" ? { status: "Ignored" } : {}),
		})),
		total: inventory.total,
		omitted: inventory.omitted,
		unmutated: inventory.unmutated,
	};
}

export function renderTable({ mutants, total, omitted, unmutated = [] }) {
	const rows = mutants.map(
		({ file, line, column, endLine, endColumn, mutatorName, replacement, status, statusReason }) =>
			[
				visibleText(JSON.stringify(file)),
				line,
				column,
				endLine,
				endColumn,
				visibleText(mutatorName),
				visibleText(JSON.stringify(replacement)),
				visibleText(JSON.stringify({ status, statusReason })),
			].join("\t"),
	);
	return [
		"FILE\tLINE\tCOLUMN\tEND_LINE\tEND_COLUMN\tMUTATOR\tREPLACEMENT\tPOLICY",
		...rows,
		...unmutated.map(
			({ file, reason }) =>
				`UNMUTATED\t${visibleText(JSON.stringify(file))}\t${visibleText(JSON.stringify(reason))}`,
		),
		"",
		`${mutants.length} of ${total} mutants; ${omitted} omitted`,
	].join("\n");
}

async function main() {
	const { values, positionals } = parseArgs({
		options: {
			json: { type: "boolean" },
			sample: { type: "string" },
			limit: { type: "string", default: String(defaultLimit) },
			help: { type: "boolean" },
		},
		allowPositionals: true,
	});
	if (values.help) {
		console.log(
			"Usage: node scripts/enumerate-mutants.mjs [range] [--json] [--limit N] [--sample FILE]\nDefaults: range origin/main...HEAD; limit 200 (output rows).\nLines are 1-based; columns are 0-based. Replacements are JSON-escaped in the table.\nRuns the checkout's own code, like its tests: trusted heads only; never a fork's head.\nReads committed source and base-sourced stryker.config.json; runs no tests or process listing.\nUses static.mutation's path exclusions, also accepts JavaScript, and applies no line budget.\nIncludes generated ignored mutants; static status needs the host's static.mutation run.\n--sample FILE prints JSON probes from a complete classified inventory; --limit applies only to enumeration.\nAdd claim (killed/new-test/equivalent/suite), evidence, and survivorClasses to every mutant.\nA suite claim stands only in a file a workspace package exports as ./testing at the inventory's head.\nSampling covers each class, mutator and file, then a hash-ordered fifth of remaining kills per file, rounded up.\nSuite claims print apart under 'suite', for a reviewer to read by their reasons.",
		);
		return;
	}
	if (positionals.length > 1) throw new Error("expected one git range");
	if (values.sample !== undefined) {
		if (positionals.length !== 0) throw new Error("use either a range or --sample FILE");
		const inventory = JSON.parse(readFileSync(values.sample, "utf8"));
		const suites =
			inventory?.melianMutants === 2 ? await SuiteExports.at(process.cwd(), inventory.range?.head) : undefined;
		console.log(jsonText(sampleMutants(inventory, suites)));
		return;
	}
	const result = await enumerateMutants({ range: positionals[0], limit: Number(values.limit) });
	console.log(values.json ? jsonText(result) : renderTable(result));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(visibleText(error.message));
		process.exitCode = 1;
	});
}
