import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sampleMutants } from "./mutant-sample.mjs";

const directory = "docs/progress-log";
const listFile = ".unreadable-inventories.json";
const sections = ["version2", "legacy"];
// Log entries' names begin with their date, and the list took every unreadable inventory merged by 2026-11-18.
const listedBefore = "2026-11-19";

// Shape alone picks an inventory out of the log, by the keys its writers emit; the sampler's reader judges it.
const isInventory = (value) =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	("melianMutants" in value || Array.isArray(value.mutants));

export function readUnreadable(list) {
	if (typeof list !== "object" || list === null || Array.isArray(list))
		throw new Error(`${listFile} must hold an object with ${sections.join(" and ")}`);
	const unknown = Object.keys(list).find((key) => !sections.includes(key));
	if (unknown !== undefined) throw new Error(`${listFile} has an unknown section ${JSON.stringify(unknown)}`);
	const entries = new Map();
	for (const section of sections) {
		if (!Array.isArray(list[section])) throw new Error(`${listFile}: ${section} must be an array`);
		for (const entry of list[section]) {
			if (typeof entry?.file !== "string" || entry.file === "" || entry.file.includes("/"))
				throw new Error(`${listFile}: ${JSON.stringify(entry)} names no file in ${directory}`);
			if (!Number.isSafeInteger(entry.pullRequest) || entry.pullRequest < 1)
				throw new Error(`${listFile}: ${entry.file} names no pull request`);
			if (!(entry.file < listedBefore))
				throw new Error(`${listFile}: ${entry.file} is newer than the list, which only shrinks; fix the inventory`);
			if (entries.has(entry.file)) throw new Error(`${listFile} names ${entry.file} twice`);
			entries.set(entry.file, section);
		}
	}
	return entries;
}

// files maps each JSON file's name in the log to its text. Returns one line per problem.
export function checkInventories({ files, unreadable }) {
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
		if (!isInventory(value)) {
			if (listed !== undefined) problems.push(`${listFile} lists ${name}, which is not an inventory`);
			continue;
		}
		let refusal;
		try {
			sampleMutants(value);
		} catch (error) {
			refusal = error.message;
		}
		const section = value.melianMutants === 2 ? "version2" : "legacy";
		if (listed === undefined) {
			if (refusal !== undefined) problems.push(`${directory}/${name}: the sampler refuses it: ${refusal}`);
		} else if (refusal === undefined) {
			problems.push(`${listFile} lists ${name}, which the sampler now reads; remove it from the list`);
		} else if (listed !== section) {
			problems.push(`${listFile} lists ${name} under ${listed}, but it is a ${section} inventory`);
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
			unreadable: readUnreadable(JSON.parse(readFileSync(listFile, "utf8"))),
		});
		for (const problem of problems) console.error(problem);
		if (problems.length > 0) {
			console.error(
				"Write a mutation inventory with `melian mutants list <range> --json --all`, then add each claim to its rows.",
			);
			process.exit(1);
		}
	} catch (error) {
		console.error(`check-inventories: ${error.message}`);
		process.exit(1);
	}
}
