#!/usr/bin/env node
// Compares the Node 24 Linux job's Vitest report with the macOS job's, so that no test Linux skips reaches main without
// passing on macOS. The macOS job runs the files scripts/macos-tests.json lists, beside the Linux jobs rather than after
// them, so this check is what makes a stale list fail instead of passing a test that never ran.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// The workflow, this script and its list are the whole of what judges a head here, and each draws a policy notice, so
// the script imports nothing from the workspace. A test holds this escaping to core's visibleText.
const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export const visible = (text) =>
	text.replace(unsafe, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

const fileOf = (name) => name.replace(/^.*?\/((packages|scripts)\/)/, "$1");

// A test is its file, its ancestor titles and its title, compared as that structure, since any title may hold " > ".
const keyOf = (file, ancestorTitles, title) => JSON.stringify([file, ancestorTitles, title]);

const testsOf = (report) =>
	report.testResults.flatMap((entry) => {
		const file = fileOf(entry.name);
		return entry.assertionResults.map((test) => ({
			key: keyOf(file, test.ancestorTitles, test.title),
			id: [file, ...test.ancestorTitles, test.title].join(" > "),
			file,
			status: test.status,
			tags: test.tags ?? [],
		}));
	});

// Vitest's report gives two tests of one name nothing else to tell them apart by, so neither is compared. Only a listed
// file's tests are compared by name, and a Linux skip in any other file fails as unlisted, so only listed files are read.
const duplicates = (tests, listed) => {
	const seen = new Set();
	const repeated = new Map();
	for (const test of tests.filter((test) => listed.has(test.file))) {
		if (seen.has(test.key)) repeated.set(test.key, test.id);
		seen.add(test.key);
	}
	return repeated;
};

/**
 * Checks seven things, and returns what it counted and every way they failed:
 * no report holds two tests of one name in a listed file; every macOS run succeeded; the Linux report shows a skipped test; every file Linux skipped a test in is listed; every test Linux skipped passed
 * on macOS; each named suite ran whole, and each tagged file's tagged tests passed; and no test macOS ran failed.
 */
export function compare({ linux, mac, list }) {
	const linuxTests = testsOf(linux);
	const macTests = mac.flatMap(testsOf);
	const macStatus = new Map(macTests.map((test) => [test.key, test.status]));
	const allowed = new Set(list.allowed.map((test) => keyOf(test.file, test.ancestorTitles, test.title)));
	const listed = new Set([...list.suites, ...list.tagged, ...list.skipped]);
	const tagged = new Set(list.tagged);
	const taggedIds = new Set(
		linuxTests.filter((test) => tagged.has(test.file) && test.tags.includes(list.tag)).map((test) => test.key),
	);
	const skipped = linuxTests.filter((test) => test.status !== "passed");
	const skippedFiles = [...new Set(skipped.map((test) => test.file))].sort();
	const lines = [`Linux skipped tests in: ${skippedFiles.join(", ")}`];
	const linuxRepeated = duplicates(linuxTests, listed);
	const macRepeated = duplicates(macTests, listed);
	const repeated = new Set([...linuxRepeated.keys(), ...macRepeated.keys()]);
	const errors = [
		...[...linuxRepeated.values()].map(
			(id) => `the Linux report holds two tests named ${id}, which cannot be told apart: rename one`,
		),
		...[...macRepeated.values()].map(
			(id) => `the macOS reports hold two tests named ${id}, which cannot be told apart: rename one`,
		),
	];

	for (const report of mac) {
		// A hook or an unhandled error fails a run whose every test passed.
		if (report.success !== true) {
			const failed = report.testResults
				.filter((entry) => entry.status === "failed")
				.map((entry) => `${fileOf(entry.name)}: ${entry.message.split("\n")[0]}`);
			errors.push(`a macOS report did not succeed: ${failed.join("; ") || "no file failed"}`);
		}
	}
	if (skipped.length === 0) errors.push("the Linux report shows no skipped test, so it cannot be the whole run");
	for (const file of skippedFiles) {
		if (!listed.has(file))
			errors.push(
				`Linux skipped a test in ${file}, which scripts/macos-tests.json does not list: add it to skipped`,
			);
	}
	for (const { key, id } of skipped.filter((test) => !repeated.has(test.key))) {
		const status = macStatus.get(key);
		if (status !== "passed" && !allowed.has(key))
			errors.push(`skipped on Linux, not passed on macOS: ${id}: ${status ?? "missing"}`);
	}
	for (const suite of list.suites) {
		const tests = macTests.filter((test) => test.file === suite);
		const counted = `${suite}: ${tests.filter((test) => test.status === "passed").length} of ${tests.length} passed`;
		lines.push(counted);
		if (tests.length === 0 || tests.some((test) => test.status !== "passed"))
			errors.push(`named suite did not run whole on macOS: ${counted}`);
	}
	for (const file of list.tagged) {
		const keys = linuxTests
			.filter((test) => test.file === file && taggedIds.has(test.key) && !repeated.has(test.key))
			.map((test) => test.key);
		const counted = `${file}: ${keys.filter((key) => macStatus.get(key) === "passed").length} of ${keys.length} tests tagged ${list.tag} passed`;
		lines.push(counted);
		if (keys.length === 0 || keys.some((key) => macStatus.get(key) !== "passed"))
			errors.push(`tagged tests did not all pass on macOS: ${counted}`);
	}
	for (const test of macTests) {
		// The tag filter reports each test it left out as skipped.
		const filteredOut = tagged.has(test.file) && !taggedIds.has(test.key) && test.status === "skipped";
		if (test.status !== "passed" && !allowed.has(test.key) && !filteredOut && !repeated.has(test.key))
			errors.push(`did not pass on macOS: ${test.id}: ${test.status}`);
	}
	if (errors.length === 0)
		lines.push(`${skipped.length} tests Linux skipped: every one passed on macOS or is allowed`);
	return { lines: lines.map(visible), errors: errors.map(visible) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { values } = parseArgs({
		options: { linux: { type: "string" }, mac: { type: "string", multiple: true }, list: { type: "string" } },
	});
	if (values.linux === undefined || values.mac === undefined || values.list === undefined) {
		process.stderr.write("usage: compare-platform-reports.mjs --linux <report> --mac <report>... --list <list>\n");
		process.exit(2);
	}
	// A parser's or reader's message quotes the file, which a test's output wrote, so it never reaches the log.
	const read = (path) => {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			process.stderr.write(`cannot read ${visible(path)} as JSON\n`);
			process.exit(1);
		}
	};
	const { lines, errors } = compare({ linux: read(values.linux), mac: values.mac.map(read), list: read(values.list) });
	for (const line of lines) process.stdout.write(`${line}\n`);
	for (const error of errors) process.stderr.write(`${error}\n`);
	process.exit(errors.length === 0 ? 0 : 1);
}
