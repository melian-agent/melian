#!/usr/bin/env node
// Compares the Node 24 Linux job's Vitest report with the macOS job's, so that no test Linux skips reaches main without
// passing on macOS. The macOS job runs the files scripts/macos-tests.json lists, beside the Linux jobs rather than after
// them, so this check is what makes a stale list fail instead of passing a test that never ran.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const fileOf = (name) => name.replace(/^.*?\/((packages|scripts)\/)/, "$1");

const testsOf = (report) =>
	report.testResults.flatMap((entry) => {
		const file = fileOf(entry.name);
		return entry.assertionResults.map((test) => ({
			id: [file, ...test.ancestorTitles, test.title].join(" > "),
			file,
			status: test.status,
			tags: test.tags ?? [],
		}));
	});

// Two tests can share a name; the name passed only if every test under it passed.
const statusById = (tests) => {
	const statuses = new Map();
	for (const { id, status } of tests) {
		const known = statuses.get(id);
		if (known === undefined || known === "passed") statuses.set(id, status);
	}
	return statuses;
};

/**
 * Checks six things, and returns what it counted and every way they failed:
 * every macOS run succeeded; the Linux report shows a skipped test; every file Linux skipped a test in is listed; every test Linux skipped passed
 * on macOS; each named suite ran whole, and each tagged file's tagged tests passed; and no test macOS ran failed.
 */
export function compare({ linux, mac, list }) {
	const linuxTests = testsOf(linux);
	const macTests = mac.flatMap(testsOf);
	const macStatus = statusById(macTests);
	const allowed = new Set(Object.keys(list.allowed));
	const listed = new Set([...list.suites, ...list.tagged, ...list.skipped]);
	const tagged = new Set(list.tagged);
	const taggedIds = new Set(
		linuxTests.filter((test) => tagged.has(test.file) && test.tags.includes(list.tag)).map((test) => test.id),
	);
	const skipped = linuxTests.filter((test) => test.status !== "passed");
	const skippedFiles = [...new Set(skipped.map((test) => test.file))].sort();
	const lines = [`Linux skipped tests in: ${skippedFiles.join(", ")}`];
	const errors = [];

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
	for (const { id } of skipped) {
		const status = macStatus.get(id);
		if (status !== "passed" && !allowed.has(id))
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
		const ids = linuxTests.filter((test) => test.file === file && taggedIds.has(test.id)).map((test) => test.id);
		const counted = `${file}: ${ids.filter((id) => macStatus.get(id) === "passed").length} of ${ids.length} tests tagged ${list.tag} passed`;
		lines.push(counted);
		if (ids.length === 0 || ids.some((id) => macStatus.get(id) !== "passed"))
			errors.push(`tagged tests did not all pass on macOS: ${counted}`);
	}
	for (const test of macTests) {
		// The tag filter reports each test it left out as skipped.
		const filteredOut = tagged.has(test.file) && !taggedIds.has(test.id) && test.status === "skipped";
		if (test.status !== "passed" && !allowed.has(test.id) && !filteredOut)
			errors.push(`did not pass on macOS: ${test.id}: ${test.status}`);
	}
	if (errors.length === 0)
		lines.push(`${skipped.length} tests Linux skipped: every one passed on macOS or is allowed`);
	return { lines, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { values } = parseArgs({
		options: { linux: { type: "string" }, mac: { type: "string", multiple: true }, list: { type: "string" } },
	});
	if (values.linux === undefined || values.mac === undefined || values.list === undefined) {
		process.stderr.write("usage: compare-platform-reports.mjs --linux <report> --mac <report>... --list <list>\n");
		process.exit(2);
	}
	const read = (path) => JSON.parse(readFileSync(path, "utf8"));
	const { lines, errors } = compare({ linux: read(values.linux), mac: values.mac.map(read), list: read(values.list) });
	for (const line of lines) process.stdout.write(`${line}\n`);
	for (const error of errors) process.stderr.write(`${error}\n`);
	process.exit(errors.length === 0 ? 0 : 1);
}
