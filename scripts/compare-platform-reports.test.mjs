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
	return {
		success: true,
		testResults: [...files].map(([file, assertionResults]) => ({
			name: `${root}${file}`,
			status: "passed",
			message: "",
			assertionResults,
		})),
	};
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
	allowed: [
		{
			file: "packages/core/test/secrets.test.ts",
			ancestorTitles: ["loadSecrets"],
			title: "refuses a command in a file another user owns",
			reason: "only root can give a file to another user",
		},
	],
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
	...value,
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
	...value,
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
		const unlisted = { ...list, allowed: [] };
		expect(compare({ linux: linux(), mac: [macWhole(), macTagged()], list: unlisted }).errors).toEqual([
			`skipped on Linux, not passed on macOS: ${allowedId}: skipped`,
			`did not pass on macOS: ${allowedId}: skipped`,
		]);
	});

	it("refuses two macOS tests of one name, one passed and the later failed", () => {
		const mac = report(...rows(macWhole()), {
			file: gated,
			title: "spells the path as the disk does",
			status: "failed",
		});
		expect(compare({ linux: linux(), mac: [mac, macTagged()], list }).errors).toEqual([
			`the macOS reports hold two tests named ${gated} > a suite > spells the path as the disk does, which cannot be told apart: rename one`,
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

	it("fails a macOS report that did not succeed, though every test in it passed", () => {
		const whole = macWhole();
		whole.success = false;
		whole.testResults[1].status = "failed";
		whole.testResults[1].message = "afterAll hook failed\nat cleanup";
		whole.testResults[2].status = "failed";
		whole.testResults[2].message = "unhandled rejection";
		expect(compare({ linux: linux(), mac: [whole, macTagged()], list }).errors).toEqual([
			`a macOS report did not succeed: ${suite}: afterAll hook failed; packages/core/test/secrets.test.ts: unhandled rejection`,
		]);
	});

	it("fails a macOS report that did not succeed with no file failed, such as an unhandled error", () => {
		const tagged = macTagged();
		tagged.success = false;
		expect(compare({ linux: linux(), mac: [macWhole(), tagged], list }).errors).toEqual([
			"a macOS report did not succeed: no file failed",
		]);
	});

	it("refuses a macOS report that says it succeeded while a file in it failed", () => {
		const whole = macWhole();
		whole.testResults[1].status = "failed";
		whole.testResults[1].message = "hook failed";
		expect(compare({ linux: linux(), mac: [whole, macTagged()], list }).errors).toEqual([
			`a macOS report says it succeeded, yet a file in it failed: ${suite}: hook failed`,
		]);
	});

	it("does not let a macOS pass in one file answer a Linux skip of the same name in another", () => {
		const other = "packages/core/test/secrets.test.ts";
		const { errors } = compare({
			linux: report(...rows(linux()), { file: gated, title: "names a twin", status: "skipped" }),
			mac: [report(...rows(macWhole()), { file: other, title: "names a twin" }), macTagged()],
			list,
		});
		expect(errors).toEqual([`skipped on Linux, not passed on macOS: ${gated} > a suite > names a twin: missing`]);
	});

	it("refuses two macOS tests of one name, one failed and the later passed", () => {
		const whole = drop(macWhole(), gated, "spells the path as the disk does");
		const mac = report(
			{ file: gated, title: "spells the path as the disk does", status: "failed" },
			{ file: gated, title: "spells the path as the disk does" },
			...rows(whole),
		);
		expect(compare({ linux: linux(), mac: [mac, macTagged()], list }).errors).toEqual([
			`the macOS reports hold two tests named ${gated} > a suite > spells the path as the disk does, which cannot be told apart: rename one`,
		]);
	});

	it("counts each tagged file's own tagged tests, not another tagged file's", () => {
		const other = "packages/pipeline/test/probe.test.ts";
		const twoFiles = { ...list, tagged: [tagged, other] };
		const linuxOther = report(...rows(linux()), { file: other, title: "plans a probe" });
		const { errors } = compare({ linux: linuxOther, mac: [macWhole(), macTagged()], list: twoFiles });
		expect(errors).toEqual([`tagged tests did not all pass on macOS: ${other}: 0 of 0 tests tagged macos passed`]);
	});

	it("fails a tagged file one of whose tagged tests macOS never ran, though another passed", () => {
		const linuxTwo = report(...rows(linux()), { file: tagged, title: "times a probe", tags: ["macos"] });
		const { errors } = compare({ linux: linuxTwo, mac: [macWhole(), macTagged()], list });
		expect(errors).toEqual([`tagged tests did not all pass on macOS: ${tagged}: 1 of 2 tests tagged macos passed`]);
	});

	it("prints no summary line when a check failed", () => {
		const { lines } = compare({
			linux: linux(),
			mac: [drop(macWhole(), gated, "spells the path as the disk does"), macTagged()],
			list,
		});
		expect(lines).toEqual([
			`Linux skipped tests in: packages/core/test/secrets.test.ts, ${gated}, ${suite}`,
			`${suite}: 1 of 1 passed`,
			`${tagged}: 1 of 1 tests tagged macos passed`,
		]);
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
			list: { suites: [], tag: "macos", tagged: [], skipped: ["scripts/codex-sandboxed.test.mjs"], allowed: [] },
		});
		expect(lines[0]).toBe("Linux skipped tests in: scripts/codex-sandboxed.test.mjs");
	});

	it("escapes control characters in what it prints, so a report cannot rewrite the log", () => {
		const forged = macWhole();
		forged.success = false;
		forged.testResults[0].status = "failed";
		forged.testResults[0].message = "\u001b[2J\u001b[HFORGED‮: all checks passed";
		const skippedTitle = "spells\u0007 the path";
		const { lines, errors } = compare({
			linux: report(...rows(linux()), { file: gated, title: skippedTitle, status: "skipped" }),
			mac: [forged, macTagged()],
			list,
		});
		expect(errors).toContain(
			`a macOS report did not succeed: ${forged.testResults[0].name.slice(root.length)}: \\u001b[2J\\u001b[HFORGED\\u202e: all checks passed`,
		);
		expect(errors).toContain(
			`skipped on Linux, not passed on macOS: ${gated} > a suite > spells\\u0007 the path: missing`,
		);
		expect([...lines, ...errors].join("\n")).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/);
	});

	it("escapes control characters in a skipped file's name where it prints the files Linux skipped in", () => {
		const file = "packages/core/test/\u001b[2Jforged.test.ts";
		const { lines } = compare({
			linux: report(...rows(linux()), { file, title: "hides", status: "skipped" }),
			mac: [macWhole(), macTagged()],
			list,
		});
		expect(lines[0]).toBe(
			`Linux skipped tests in: packages/core/test/\\u001b[2Jforged.test.ts, packages/core/test/secrets.test.ts, ${gated}, ${suite}`,
		);
	});

	it("escapes the Arabic letter mark, a bidi control core's visibleText escapes", () => {
		const { errors } = compare({
			linux: report(...rows(linux()), { file: gated, title: "reads \u061c backwards", status: "skipped" }),
			mac: [macWhole(), macTagged()],
			list,
		});
		expect(errors).toEqual([
			`skipped on Linux, not passed on macOS: ${gated} > a suite > reads \\u061c backwards: missing`,
		]);
	});

	it("does not let a test whose title holds the separator borrow another test's pass", () => {
		const { errors } = compare({
			linux: report(...rows(linux()), { file: gated, ancestors: ["s"], title: "b > c", status: "skipped" }),
			mac: [report(...rows(macWhole()), { file: gated, ancestors: ["s", "b"], title: "c" }), macTagged()],
			list,
		});
		expect(errors).toEqual([`skipped on Linux, not passed on macOS: ${gated} > s > b > c: missing`]);
	});
});

describe("how the comparison names a test", () => {
	it("refuses a Linux report holding a platform-only skip beside a test of the same name, which one macOS pass cannot answer for both", () => {
		const { errors } = compare({
			linux: report(
				...rows(linux()),
				{ file: gated, title: "same", status: "skipped" },
				{ file: gated, title: "same" },
			),
			mac: [report(...rows(macWhole()), { file: gated, title: "same" }), macTagged()],
			list,
		});
		expect(errors).toEqual([
			`the Linux report holds two tests named ${gated} > a suite > same, which cannot be told apart: rename one`,
		]);
	});

	it("accepts two passed tests of one name in a file the list does not name, since nothing compares them by name", () => {
		const unlisted = "packages/cli/test/cli.test.ts";
		const { errors } = compare({
			linux: report(...rows(linux()), { file: unlisted, title: "prints its help" }),
			mac: [
				report(
					...rows(macWhole()),
					{ file: unlisted, title: "prints its help" },
					{ file: unlisted, title: "prints its help" },
				),
				macTagged(),
			],
			list,
		});
		expect(errors).toEqual([]);
	});

	it("refuses two passed tests of one name in a file the list names", () => {
		const { errors } = compare({
			linux: report(...rows(linux()), { file: tagged, title: "records a plan" }),
			mac: [macWhole(), macTagged()],
			list,
		});
		expect(errors).toEqual([
			`the Linux report holds two tests named ${tagged} > a suite > records a plan, which cannot be told apart: rename one`,
		]);
	});

	it("refuses a macOS report holding two tests of one name", () => {
		const { errors } = compare({
			linux: linux(),
			mac: [report(...rows(macWhole()), { file: gated, title: "runs anywhere" }), macTagged()],
			list,
		});
		expect(errors).toEqual([
			`the macOS reports hold two tests named ${gated} > a suite > runs anywhere, which cannot be told apart: rename one`,
		]);
	});

	it("does not let a test whose joined name matches the allowed test's take its exemption", () => {
		const forged = {
			file: "packages/core/test/secrets.test.ts",
			ancestors: [],
			title: "loadSecrets > refuses a command in a file another user owns",
			status: "skipped",
		};
		const { errors } = compare({
			linux: report(...rows(linux()), forged),
			mac: [report(...rows(macWhole()), forged), macTagged()],
			list,
		});
		expect(errors).toEqual([
			`skipped on Linux, not passed on macOS: ${allowedId}: skipped`,
			`did not pass on macOS: ${allowedId}: skipped`,
		]);
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

	it("names a report it cannot parse and prints none of the parser's text, which quotes the file", () => {
		const dir = mkdtempSync(join(tmpdir(), "melian-compare-reports-"));
		try {
			const broken = join(dir, "linux.json");
			writeFileSync(broken, '{"testResults": "\u001b[2J\u001b[HFORGED: all checks passed');
			const listFile = join(dir, "list.json");
			writeFileSync(listFile, JSON.stringify(list));
			const result = run(["--linux", broken, "--mac", broken, "--list", listFile]);
			expect([result.status, result.stdout, result.stderr]).toEqual([1, "", `cannot read ${broken} as JSON\n`]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		["a Linux report", ["--mac", "b.json", "--list", "c.json"]],
		["a macOS report", ["--linux", "a.json", "--list", "c.json"]],
		["a list", ["--linux", "a.json", "--mac", "b.json"]],
	])("refuses to run without %s", (_, args) => {
		const result = run(args);
		expect([result.status, result.stdout, result.stderr]).toEqual([
			2,
			"",
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
