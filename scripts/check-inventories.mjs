import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { visibleText } from "../packages/core/src/render.ts";
import { sampleMutants } from "./mutant-sample.mjs";

const directory = "docs/progress-log";
const listFile = ".unreadable-inventories.json";
const sections = ["version2", "legacy"];

// A file is an inventory by the keys its writers emit or by its name, so one that lost both keys still reaches the
// sampler; the sampler's reader judges it.
const hasInventoryKeys = (value) =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	("melianMutants" in value || "mutants" in value);
// Merged files named as inventories that hold hand-run results, not an inventory, with why each is no inventory.
export const runLogs = new Map([
	["2026-11-07-pr-299-mutants.json", "an array of hand mutant runs, each with its test and result"],
	["2026-11-14-issue-394-wave-mutants.json", "an array of hand mutant runs, each with its baseline and result"],
]);
const isInventory = (name, value) => hasInventoryKeys(value) || (name.includes("mutants") && !runLogs.has(name));

// main is main's copy of the list, or undefined before main has one; an entry it lacks is a new one.
export function readUnreadable(list, main) {
	if (typeof list !== "object" || list === null || Array.isArray(list))
		throw new Error(`${listFile} must hold an object with ${sections.join(" and ")}`);
	const unknown = Object.keys(list).find((key) => !sections.includes(key));
	if (unknown !== undefined) throw new Error(`${listFile} has an unknown section ${JSON.stringify(unknown)}`);
	const onMain = main === undefined ? undefined : new Set(entriesOf(main));
	const entries = new Map();
	for (const section of sections) {
		if (!Array.isArray(list[section])) throw new Error(`${listFile}: ${section} must be an array`);
		for (const entry of list[section]) {
			if (typeof entry?.file !== "string" || entry.file === "" || entry.file.includes("/"))
				throw new Error(`${listFile}: ${JSON.stringify(entry)} names no file in ${directory}`);
			if (!Number.isSafeInteger(entry.pullRequest) || entry.pullRequest < 1)
				throw new Error(`${listFile}: ${entry.file} names no pull request`);
			if (onMain !== undefined && !onMain.has(`${section} ${entry.file} ${entry.pullRequest}`))
				throw new Error(`${listFile}: ${entry.file} is not on main's list, which only shrinks; fix the inventory`);
			if (entries.has(entry.file)) throw new Error(`${listFile} names ${entry.file} twice`);
			entries.set(entry.file, section);
		}
	}
	return entries;
}

const entriesOf = (list) =>
	sections.flatMap((section) =>
		(list?.[section] ?? []).map((entry) => `${section} ${entry?.file} ${entry?.pullRequest}`),
	);

// The gate compares with origin/main, which CI fetches; without it the list cannot be judged, so the check fails.
function mainList() {
	const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	try {
		git("rev-parse", "--verify", "--quiet", "origin/main^{commit}");
	} catch {
		throw new Error("cannot read origin/main to compare the list with; run `git fetch origin main`");
	}
	if (!git("ls-tree", "--name-only", "origin/main", "--", listFile).trim()) return undefined;
	return JSON.parse(git("show", `origin/main:${listFile}`));
}

function mainFile(name) {
	try {
		return execFileSync("git", ["show", `origin/main:${directory}/${name}`], {
			encoding: "utf8",
			maxBuffer: 64 << 20,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

// files maps each JSON file's name in the log to its text. Returns one line per problem.
// onMain(name) gives main's text of a log file, or undefined where main lacks it.
export function checkInventories({ files, unreadable, onMain }) {
	const problems = [];
	for (const [name, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
		let value;
		try {
			value = JSON.parse(text);
		} catch {
			problems.push(`${directory}/${name} is not JSON`);
			continue;
		}
		const listed = unreadable.get(name);
		if (!isInventory(name, value)) {
			if (listed !== undefined) problems.push(`${listFile} lists ${name}, which is not an inventory`);
			continue;
		}
		let refusal;
		try {
			sampleMutants(value);
		} catch (error) {
			refusal = error.message;
		}
		const section = value?.melianMutants === 2 ? "version2" : "legacy";
		if (listed === undefined) {
			if (refusal !== undefined) problems.push(`${directory}/${name}: the sampler refuses it: ${refusal}`);
		} else if (refusal === undefined) {
			problems.push(`${listFile} lists ${name}, which the sampler now reads; remove it from the list`);
		} else if (listed !== section) {
			problems.push(`${listFile} lists ${name} under ${listed}, but it is a ${section} inventory`);
		} else if (onMain(name) !== text) {
			problems.push(`${listFile} lists ${name}, but it differs from main's copy; fix the inventory`);
		}
	}
	for (const name of unreadable.keys())
		if (!files.has(name)) problems.push(`${listFile} lists ${name}, which is not in ${directory}`);
	return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const files = new Map(
			readdirSync(directory)
				.filter((name) => name.endsWith(".json"))
				.map((name) => [name, readFileSync(join(directory, name), "utf8")]),
		);
		const problems = checkInventories({
			files,
			unreadable: readUnreadable(JSON.parse(readFileSync(listFile, "utf8")), mainList()),
			onMain: mainFile,
		});
		for (const problem of problems) console.error(visibleText(problem));
		if (problems.length > 0) {
			console.error(
				"Write a mutation inventory with `melian mutants list <range> --json --all`, then add each claim to its rows.",
			);
			process.exit(1);
		}
	} catch (error) {
		console.error(`check-inventories: ${visibleText(error.message)}`);
		process.exit(1);
	}
}
