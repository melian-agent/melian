import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Changeset } from "../packages/core/src/changeset.ts";
import { gitOutput } from "../packages/core/src/git.ts";
import {
	configuration,
	nonRegularEntry,
	productionWithExtensions as production,
	signalFiles,
} from "../packages/pipeline/src/mutation-paths.ts";

import { sampleMutants } from "./mutant-sample.mjs";

const defaultLimit = 200;
const extensions = /\.[cm]?[jt]sx?$/;
const instrumenter = fileURLToPath(new URL("./instrument-mutants.mjs", import.meta.url));

export async function enumerateMutants({
	cwd = process.cwd(),
	range = "origin/main...HEAD",
	limit = defaultLimit,
} = {}) {
	if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit must be a non-negative safe integer");
	const { repoRoot, revision } = await Changeset.resolve(cwd, range);
	const files = [];
	const unmutated = [];
	for (const [name, ranges] of Object.entries(revision.diffLines())) {
		if (!production(name, extensions)) continue;
		const kind = revision.files.find((file) => file.path === name).newKind;
		if (kind !== "file" && kind !== "executable") {
			unmutated.push({ file: name, reason: nonRegularEntry(kind).why });
			continue;
		}
		if (configuration.test(name) || signalFiles.has(name) || name.includes(",")) continue;
		files.push({
			name,
			content: await gitOutput(repoRoot, ["show", `${revision.head}:${name}`]),
			mutate: ranges.map(([first, last]) => ({
				start: { line: first - 1, column: 0 },
				end: { line: last - 1, column: Number.MAX_SAFE_INTEGER },
			})),
		});
	}
	const config = JSON.parse(await gitOutput(repoRoot, ["show", `${revision.head}:stryker.config.json`]));
	const scratch = mkdtempSync(join(tmpdir(), `melian-enumerate-${process.pid}-`));
	let mutants;
	try {
		// Stryker's JavaScript parser loads Babel configuration from cwd and the input's ancestors.
		mutants = JSON.parse(
			execFileSync(process.execPath, [instrumenter], {
				cwd: scratch,
				input: JSON.stringify({
					files,
					options: { plugins: null, excludedMutations: [], ...config.mutator, ignorers: [] },
				}),
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			}),
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	const rows = mutants.map(({ fileName, location, mutatorName, replacement, status, statusReason }) => ({
		file: fileName,
		line: location.start.line + 1,
		column: location.start.column,
		endLine: location.end.line + 1,
		endColumn: location.end.column,
		mutatorName,
		replacement,
		status,
		statusReason,
	}));
	return { mutants: rows.slice(0, limit), total: rows.length, omitted: Math.max(0, rows.length - limit), unmutated };
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
			"Usage: node scripts/enumerate-mutants.mjs [range] [--json] [--limit N] [--sample FILE]\nDefaults: range origin/main...HEAD; limit 200 (output rows).\nLines are 1-based; columns are 0-based. Replacements are JSON-escaped in the table.\nRuns the checkout's own code, like its tests: trusted heads only; never a fork's head.\nReads committed source and stryker.config.json; runs no tests or process listing.\nUses static.mutation's path exclusions, also accepts JavaScript, and applies no line budget.\nIncludes generated ignored mutants; static status needs the host's static.mutation run.\n--sample FILE prints JSON probes from a complete classified inventory; --limit applies only to enumeration.\nAdd claim (killed/new-test/equivalent), evidence, and survivorClasses to every mutant.\nSampling covers each class, mutator and file, then a hash-ordered fifth of remaining kills per file, rounded up.",
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
