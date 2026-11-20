import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare } from "./compare-platform-reports.mjs";

const script = join(import.meta.dirname, "compare-platform-reports.mjs");

const root = "/runner/work/melian/melian/";

// A Vitest JSON report, as `--reporter=json` writes it: absolute file names, one entry per test.
const report = (...tests) => {
	const files = new Map();
	for (const { file, title, ancestors = ["a suite"], status = "passed", tags = [] } of tests) {
		const results = files.get(file) ?? [];
		results.push({ ancestorTitles: ancestors, title, status, tags });
		files.set(file, results);
	}
	return { testResults: [...files].map(([file, assertionResults]) => ({ name: `${root}${file}`, assertionResults })) };
};

const suite = "packages/pipeline/test/probe-sandbox.test.ts";
const tagged = "packages/pipeline/test/probing-level.test.ts";
const gated = "packages/core/test/worktree-spelling.test.ts";
const allowedId = "packages/core/test/secrets.test.ts > loadSecrets > refuses a command in a file another user owns";
const list = {
	suites: [suite],
	tag: "macos",
	tagged: [tagged],
	skipped: [gated, "packages/core/test/secrets.test.ts"],
	allowed: { [allowedId]: "only root can give a file to another user" },
};

// Linux skips one test of the gated file and the whole sandbox suite, and runs every test of the tagged file.
const linux = () =>
	report(
		{ file: gated, title: "spells the path as the disk does", status: "skipped" },
		{ file: gated, title: "runs anywhere" },
		{ file: suite, title: "confines a probe", status: "skipped" },
		{ file: tagged, title: "runs probes one at a time", tags: ["macos"] },
		{ file: tagged, title: "records a plan" },
		{
			file: "packages/core/test/secrets.test.ts",
			ancestors: ["loadSecrets"],
			title: "refuses a command in a file another user owns",
			status: "skipped",
		},
		{ file: "packages/cli/test/cli.test.ts", title: "prints its help" },
	);

const macWhole = () =>
	report(
		{ file: gated, title: "spells the path as the disk does" },
		{ file: gated, title: "runs anywhere" },
		{ file: suite, title: "confines a probe" },
		{
			file: "packages/core/test/secrets.test.ts",
			ancestors: ["loadSecrets"],
			title: "refuses a command in a file another user owns",
			status: "skipped",
		},
	);

// The tagged run: Vitest reports a test the tag filter left out as skipped.
const macTagged = () =>
	report(
		{ file: tagged, title: "runs probes one at a time", tags: ["macos"] },
		{ file: tagged, title: "records a plan", status: "skipped" },
	);

// The tests a report holds, in the shape report() takes.
const rows = (value) =>
	value.testResults.flatMap((entry) =>
		entry.assertionResults.map((test) => ({
			file: entry.name.slice(root.length),
			title: test.title,
			ancestors: test.ancestorTitles,
			status: test.status,
			tags: test.tags,
		})),
	);

const drop = (value, file, title) => ({
	testResults: value.testResults
		.map((entry) => ({
			...entry,
			assertionResults: entry.assertionResults.filter(
				(test) => !(entry.name.endsWith(file) && test.title === title),
			),
		}))
		.filter((entry) => entry.assertionResults.length > 0),
});

const restatus = (value, file, title, status) => ({
	testResults: value.testResults.map((entry) => ({
		...entry,
		assertionResults: entry.assertionResults.map((test) =>
			entry.name.endsWith(file) && test.title === title ? { ...test, status } : test,
		),
	})),
});

describe("compare", () => {
	it("passes when every test Linux skipped passed on macOS, and says what it counted", () => {
		expect(compare({ linux: linux(), mac: [macWhole(), macTagged()], list })).toEqual({
			lines: [
				`Linux skipped tests in: packages/core/test/secrets.test.ts, ${gated}, ${suite}`,
				`${suite}: 1 of 1 passed`,
				`${tagged}: 1 of 1 tests tagged macos passed`,
				"3 tests Linux skipped: every one passed on macOS or is allowed",
			],
			errors: [],
		});
	});

	it("fails a test Linux skipped that is missing from the macOS report", () => {
		const { errors } = compare({
			linux: linux(),
			mac: [drop(macWhole(), gated, "spells the path as the disk does"), macTagged()],
			list,
		});
		expect(errors).toEqual([
			`skipped on Linux, not passed on macOS: ${gated} > a suite > spells the path as the disk does: missing`,
		]);
	});

	it("fails a test Linux skipped that macOS skipped too", () => {
		const { errors } = compare({
			linux: linux(),
			mac: [restatus(macWhole(), gated, "spells the path as the disk does", "skipped"), macTagged()],
			list,
		});
		expect(errors).toEqual([
			`skipped on Linux, not passed on macOS: ${gated} > a suite > spells the path as the disk does: skipped`,
			`did not pass on macOS: ${gated} > a suite > spells the path as the disk does: skipped`,
		]);
	});

	it("allows only the allowed test to pass on neither", () => {
		const unlisted = { ...list, allowed: {} };
		expect(compare({ linux: linux(), mac: [macWhole(), macTagged()], list: unlisted }).errors).toEqual([
			`skipped on Linux, not passed on macOS: ${allowedId}: skipped`,
			`did not pass on macOS: ${allowedId}: skipped`,
		]);
	});

	it("counts a test that passed under one of two identical names and failed under the other as not passed", () => {
		const mac = report(...rows(macWhole()), {
			file: gated,
			title: "spells the path as the disk does",
			status: "failed",
		});
		expect(compare({ linux: linux(), mac: [mac, macTagged()], list }).errors).toEqual([
			`skipped on Linux, not passed on macOS: ${gated} > a suite > spells the path as the disk does: failed`,
			`did not pass on macOS: ${gated} > a suite > spells the path as the disk does: failed`,
		]);
	});

	it("fails a named suite that did not run on macOS", () => {
		const linuxRan = restatus(linux(), suite, "confines a probe", "passed");
		const { lines, errors } = compare({
			linux: linuxRan,
			mac: [drop(macWhole(), suite, "confines a probe"), macTagged()],
			list,
		});
		expect(lines).toContain(`${suite}: 0 of 0 passed`);
		expect(errors).toEqual([`named suite did not run whole on macOS: ${suite}: 0 of 0 passed`]);
	});

	it("fails a named suite with a test that did not pass on macOS, though Linux ran it", () => {
		const linuxRan = restatus(linux(), suite, "confines a probe", "passed");
		const mac = report(...rows(macWhole()), { file: suite, title: "kills its children", status: "skipped" });
		expect(compare({ linux: linuxRan, mac: [mac, macTagged()], list }).errors).toEqual([
			`named suite did not run whole on macOS: ${suite}: 1 of 2 passed`,
			`did not pass on macOS: ${suite} > a suite > kills its children: skipped`,
		]);
	});

	it("fails a tagged file whose tagged test did not pass on macOS", () => {
		const { errors } = compare({
			linux: linux(),
			mac: [macWhole(), drop(macTagged(), tagged, "runs probes one at a time")],
			list,
		});
		expect(errors).toEqual([`tagged tests did not all pass on macOS: ${tagged}: 0 of 1 tests tagged macos passed`]);
	});

	it("fails a tagged file in which Linux saw no tagged test, so a lost marker runs nothing unseen", () => {
		const untagged = report(...rows(linux()).map((row) => ({ ...row, tags: [] })));
		const { errors } = compare({ linux: untagged, mac: [macWhole(), macTagged()], list });
		expect(errors).toEqual([`tagged tests did not all pass on macOS: ${tagged}: 0 of 0 tests tagged macos passed`]);
	});

	it("reads a test's tag from the Linux report, not from the macOS one", () => {
		const unmarked = restatus(macTagged(), tagged, "runs probes one at a time", "passed");
		unmarked.testResults[0].assertionResults[0].tags = [];
		expect(compare({ linux: linux(), mac: [macWhole(), unmarked], list }).errors).toEqual([]);
	});

	it("leaves out an untagged test of a tagged file that macOS skipped, and fails one that failed", () => {
		expect(
			compare({ linux: linux(), mac: [macWhole(), restatus(macTagged(), tagged, "records a plan", "failed")], list })
				.errors,
		).toEqual([`did not pass on macOS: ${tagged} > a suite > records a plan: failed`]);
	});

	it("fails a test that failed on macOS in a file only listed for its skips", () => {
		expect(
			compare({ linux: linux(), mac: [restatus(macWhole(), gated, "runs anywhere", "failed"), macTagged()], list })
				.errors,
		).toEqual([`did not pass on macOS: ${gated} > a suite > runs anywhere: failed`]);
	});

	it("fails a Linux report that shows no skipped test", () => {
		const none = report(
			{ file: tagged, title: "runs probes one at a time", tags: ["macos"] },
			{ file: suite, title: "confines a probe" },
		);
		const mac = report({ file: suite, title: "confines a probe" });
		expect(compare({ linux: none, mac: [mac, macTagged()], list }).errors).toEqual([
			"the Linux report shows no skipped test, so it cannot be the whole run",
		]);
	});

	it("fails a file Linux skipped a test in that the list leaves out, naming the file to add", () => {
		const extra = report(...rows(linux()), {
			file: "packages/core/test/launchd.test.ts",
			title: "talks to launchd",
			status: "skipped",
		});
		expect(compare({ linux: extra, mac: [macWhole(), macTagged()], list }).errors).toEqual([
			"Linux skipped a test in packages/core/test/launchd.test.ts, which scripts/macos-tests.json does not list: add it to skipped",
			"skipped on Linux, not passed on macOS: packages/core/test/launchd.test.ts > a suite > talks to launchd: missing",
		]);
	});

	it("counts a file Linux skipped in as listed when the list names it as a suite or a tagged file", () => {
		const skipping = restatus(linux(), tagged, "records a plan", "skipped");
		const mac = restatus(macTagged(), tagged, "records a plan", "skipped");
		const { errors } = compare({ linux: skipping, mac: [macWhole(), mac], list });
		expect(errors).toEqual([`skipped on Linux, not passed on macOS: ${tagged} > a suite > records a plan: skipped`]);
	});

	it("names a file by its path from the checkout's packages or scripts folder", () => {
		const nested = {
			testResults: [
				{
					name: "/Users/runner/work/melian/melian/scripts/codex-sandboxed.test.mjs",
					assertionResults: [{ ancestorTitles: [], title: "t", status: "skipped", tags: [] }],
				},
			],
		};
		const { lines } = compare({
			linux: nested,
			mac: [{ testResults: [] }],
			list: { suites: [], tag: "macos", tagged: [], skipped: ["scripts/codex-sandboxed.test.mjs"], allowed: {} },
		});
		expect(lines[0]).toBe("Linux skipped tests in: scripts/codex-sandboxed.test.mjs");
	});
});

describe("the command", () => {
	const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

	it("exits 0 and prints its counts when the reports agree, and 1 with each error when they do not", () => {
		const dir = mkdtempSync(join(tmpdir(), "melian-compare-reports-"));
		try {
			const write = (name, value) => {
				writeFileSync(join(dir, name), JSON.stringify(value));
				return join(dir, name);
			};
			const args = [
				"--linux",
				write("linux.json", linux()),
				"--mac",
				write("whole.json", macWhole()),
				"--mac",
				write("tagged.json", macTagged()),
				"--list",
				write("list.json", list),
			];
			const passed = run(args);
			expect([passed.status, passed.stdout.trim().split("\n").at(-1), passed.stderr]).toEqual([
				0,
				"3 tests Linux skipped: every one passed on macOS or is allowed",
				"",
			]);
			args[3] = write("whole.json", drop(macWhole(), gated, "spells the path as the disk does"));
			const failed = run(args);
			expect([failed.status, failed.stderr]).toEqual([
				1,
				`skipped on Linux, not passed on macOS: ${gated} > a suite > spells the path as the disk does: missing\n`,
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses to run without a Linux report, a macOS report and a list", () => {
		const result = run(["--linux", "a.json"]);
		expect([result.status, result.stderr]).toEqual([
			2,
			"usage: compare-platform-reports.mjs --linux <report> --mac <report>... --list <list>\n",
		]);
	});
});

describe("the committed list", () => {
	const committed = JSON.parse(readFileSync(join(import.meta.dirname, "macos-tests.json"), "utf8"));

	it("names the tag the tagged file marks its timing tests with, and the tag Vitest knows", () => {
		const source = readFileSync(join(import.meta.dirname, "..", committed.tagged[0]), "utf8");
		const config = readFileSync(join(import.meta.dirname, "..", "vitest.config.ts"), "utf8");
		expect([
			committed.tag,
			committed.tagged,
			source.includes(`tags: ["${committed.tag}"]`),
			config.includes(`name: "${committed.tag}"`),
		]).toEqual(["macos", ["packages/pipeline/test/probing-level.test.ts"], true, true]);
	});
});
