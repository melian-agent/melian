import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { sampleMutants } from "./mutant-sample.mjs";

const defaultLimit = 200;

export async function enumerateMutants({
	cwd = process.cwd(),
	range = "origin/main...HEAD",
	limit = defaultLimit,
} = {}) {
	if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit must be a non-negative safe integer");
	const cli = fileURLToPath(new URL("../packages/cli/bin/melian.js", import.meta.url));
	const output = execFileSync(process.execPath, [cli, "mutants", "list", range, "--json", "--limit", String(limit)], {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
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
				JSON.stringify(file),
				line,
				column,
				endLine,
				endColumn,
				mutatorName,
				JSON.stringify(replacement),
				JSON.stringify({ status, statusReason }),
			].join("\t"),
	);
	return [
		"FILE\tLINE\tCOLUMN\tEND_LINE\tEND_COLUMN\tMUTATOR\tREPLACEMENT\tPOLICY",
		...rows,
		...unmutated.map(({ file, reason }) => `UNMUTATED\t${JSON.stringify(file)}\t${JSON.stringify(reason)}`),
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
			"Usage: node scripts/enumerate-mutants.mjs [range] [--json] [--limit N] [--sample FILE]\nDefaults: range origin/main...HEAD; limit 200 (output rows).\nLines are 1-based; columns are 0-based. Replacements are JSON-escaped in the table.\nRuns the checkout's own code, like its tests: trusted heads only; never a fork's head.\nReads committed source and base-sourced stryker.config.json; runs no tests or process listing.\nUses static.mutation's path exclusions, also accepts JavaScript, and applies no line budget.\nIncludes generated ignored mutants; static status needs the host's static.mutation run.\n--sample FILE prints JSON probes from a complete classified inventory; --limit applies only to enumeration.\nAdd claim (killed/new-test/equivalent), evidence, and survivorClasses to every mutant.\nSampling covers each class, mutator and file, then a hash-ordered fifth of remaining kills per file, rounded up.",
		);
		return;
	}
	if (positionals.length > 1) throw new Error("expected one git range");
	if (values.sample !== undefined) {
		if (positionals.length !== 0) throw new Error("use either a range or --sample FILE");
		console.log(JSON.stringify(sampleMutants(JSON.parse(readFileSync(values.sample, "utf8"))), null, 2));
		return;
	}
	const result = await enumerateMutants({ range: positionals[0], limit: Number(values.limit) });
	console.log(values.json ? JSON.stringify(result, null, 2) : renderTable(result));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
