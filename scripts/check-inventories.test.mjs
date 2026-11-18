import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkInventories, readUnreadable } from "./check-inventories.mjs";
import { sampleMutants } from "./mutant-sample.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const log = join(root, "docs/progress-log");
const readableName = "2026-11-16-pr-492-memo-mutants.json";
const readable = readFileSync(join(log, readableName), "utf8");

// Pull request #552's fault: test evidence written as a display name, where version 2 wants a path of titles.
const malformed = () => {
	const inventory = JSON.parse(readable);
	inventory.mutants[0].evidence = { test: { file: "packages/pipeline/test/list-mutants.test.ts", name: "A > B" } };
	return JSON.stringify(inventory);
};
const refusalOf = (text) => {
	try {
		sampleMutants(JSON.parse(text));
	} catch (error) {
		return error.message;
	}
	throw new Error("the sampler read the fixture");
};

const unreadable = (entries = {}) => new Map(Object.entries(entries));
const check = (files, entries, main = files) =>
	checkInventories({
		files: new Map(Object.entries(files)),
		unreadable: unreadable(entries),
		onMain: (name) => main[name],
	});

describe("checkInventories", () => {
	it("fails an inventory the sampler refuses, with the sampler's own message", () => {
		const text = malformed();
		expect(check({ "2026-11-19-new-mutants.json": text })).toEqual([
			`docs/progress-log/2026-11-19-new-mutants.json: the sampler refuses it: ${refusalOf(text)}`,
		]);
	});

	it("passes an inventory the sampler reads", () => {
		expect(check({ [readableName]: readable })).toEqual([]);
	});

	it("leaves a run log alone, and judges a file by its shape alone", () => {
		expect(
			check({
				"runs.json": JSON.stringify({ head: "abc", runs: [{ result: "killed" }] }),
				"array.json": JSON.stringify([{ mutants: [] }]),
				"empty-mutants.json": JSON.stringify({ mutants: [] }),
				"version.json": JSON.stringify({ melianMutants: 2 }),
				"not-array.json": JSON.stringify({ mutants: "oops" }),
			}),
		).toEqual([
			`docs/progress-log/empty-mutants.json: the sampler refuses it: ${refusalOf(JSON.stringify({ mutants: [] }))}`,
			`docs/progress-log/not-array.json: the sampler refuses it: ${refusalOf(JSON.stringify({ mutants: "oops" }))}`,
			`docs/progress-log/version.json: the sampler refuses it: ${refusalOf(JSON.stringify({ melianMutants: 2 }))}`,
		]);
	});

	it("fails a file that is not JSON", () => {
		expect(check({ "broken.json": "{" })).toEqual(["docs/progress-log/broken.json is not JSON"]);
	});

	it("accepts a listed inventory the sampler still refuses", () => {
		expect(check({ "old-mutants.json": malformed() }, { "old-mutants.json": "version2" })).toEqual([]);
	});

	it("fails a listed inventory that differs from main's copy, or that main lacks", () => {
		const emptied = JSON.stringify({ melianMutants: 2, mutants: [] });
		const problem =
			".unreadable-inventories.json lists old-mutants.json, but it differs from main's copy; fix the inventory";
		expect(
			check(
				{ "old-mutants.json": emptied },
				{ "old-mutants.json": "version2" },
				{ "old-mutants.json": malformed() },
			),
		).toEqual([problem]);
		expect(check({ "old-mutants.json": malformed() }, { "old-mutants.json": "version2" }, {})).toEqual([problem]);
	});

	it("fails a listed inventory the sampler now reads, so the list only shrinks", () => {
		expect(check({ [readableName]: readable }, { [readableName]: "version2" })).toEqual([
			`.unreadable-inventories.json lists ${readableName}, which the sampler now reads; remove it from the list`,
		]);
	});

	it("fails a listed file under the wrong version", () => {
		expect(check({ "old-mutants.json": malformed() }, { "old-mutants.json": "legacy" })).toEqual([
			".unreadable-inventories.json lists old-mutants.json under legacy, but it is a version2 inventory",
		]);
	});

	it("fails a listed file that is gone or is no inventory", () => {
		expect(check({ "runs.json": "{}" }, { "runs.json": "legacy", "gone-mutants.json": "legacy" })).toEqual([
			".unreadable-inventories.json lists runs.json, which is not an inventory",
			".unreadable-inventories.json lists gone-mutants.json, which is not in docs/progress-log",
		]);
	});
});

describe("readUnreadable", () => {
	const entry = (file, pullRequest = 552) => ({ file, pullRequest });

	it("reads each file's version section", () => {
		expect(
			readUnreadable({
				version2: [entry("2026-11-18-a-mutants.json")],
				legacy: [entry("2026-11-07-b-mutants.json")],
			}),
		).toEqual(
			new Map([
				["2026-11-18-a-mutants.json", "version2"],
				["2026-11-07-b-mutants.json", "legacy"],
			]),
		);
	});

	it("refuses an entry main's list lacks, whatever its date, so the list only shrinks", () => {
		const main = { version2: [entry("2026-11-17-a-mutants.json")], legacy: [] };
		expect(() =>
			readUnreadable(
				{ version2: [entry("2026-11-17-a-mutants.json"), entry("2026-11-01-b-mutants.json")], legacy: [] },
				main,
			),
		).toThrow(
			".unreadable-inventories.json: 2026-11-01-b-mutants.json is not on main's list, which only shrinks; fix the inventory",
		);
	});

	it("refuses an entry whose section or pull request differs from main's list", () => {
		const main = { version2: [entry("2026-11-17-a-mutants.json")], legacy: [] };
		expect(() => readUnreadable({ version2: [], legacy: [entry("2026-11-17-a-mutants.json")] }, main)).toThrow(
			"2026-11-17-a-mutants.json is not on main's list",
		);
		expect(() => readUnreadable({ version2: [entry("2026-11-17-a-mutants.json", 553)], legacy: [] }, main)).toThrow(
			"2026-11-17-a-mutants.json is not on main's list",
		);
	});

	it("accepts a list that drops main's entries, and any list when main has none", () => {
		const main = { version2: [entry("2026-11-17-a-mutants.json")], legacy: [entry("2026-11-07-b-mutants.json")] };
		expect(readUnreadable({ version2: [], legacy: [entry("2026-11-07-b-mutants.json")] }, main)).toEqual(
			new Map([["2026-11-07-b-mutants.json", "legacy"]]),
		);
		expect(readUnreadable({ version2: [entry("2026-11-30-c-mutants.json")], legacy: [] }, undefined)).toEqual(
			new Map([["2026-11-30-c-mutants.json", "version2"]]),
		);
	});

	it("refuses a file named twice, a missing pull request, a path, or an unknown section", () => {
		const file = "2026-11-17-a-mutants.json";
		expect(() => readUnreadable({ version2: [entry(file)], legacy: [entry(file)] })).toThrow(`names ${file} twice`);
		expect(() => readUnreadable({ version2: [entry(file, 0)], legacy: [] })).toThrow(`${file} names no pull request`);
		expect(() => readUnreadable({ version2: [entry(`x/${file}`)], legacy: [] })).toThrow("names no file");
		expect(() => readUnreadable({ version2: [], legacy: [], other: [] })).toThrow('unknown section "other"');
		expect(() => readUnreadable({ version2: [] })).toThrow("legacy must be an array");
	});
});

describe("the committed log", () => {
	it("holds no inventory the sampler refuses beyond the list, and the list holds nothing it reads", () => {
		const files = new Map(
			readdirSync(log)
				.filter((name) => name.endsWith(".json"))
				.map((name) => [name, readFileSync(join(log, name), "utf8")]),
		);
		const list = JSON.parse(readFileSync(join(root, ".unreadable-inventories.json"), "utf8"));
		expect(checkInventories({ files, unreadable: readUnreadable(list), onMain: (name) => files.get(name) })).toEqual(
			[],
		);
	});
});

describe("the gate's command", () => {
	let scratch;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "melian-inventories-"));
		mkdirSync(join(scratch, "docs/progress-log"), { recursive: true });
		writeFileSync(join(scratch, ".unreadable-inventories.json"), JSON.stringify({ version2: [], legacy: [] }));
	});
	const git = (...args) =>
		spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
			cwd: scratch,
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		});
	const commitMain = () => {
		git("init", "-q");
		git("add", "-A");
		git("commit", "-q", "-m", "main");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
	};
	afterEach(() => rmSync(scratch, { recursive: true, force: true }));

	const run = () =>
		spawnSync(process.execPath, [join(root, "scripts/check-inventories.mjs")], { cwd: scratch, encoding: "utf8" });

	it("exits 1 with the sampler's message for a malformed inventory", () => {
		commitMain();
		const text = malformed();
		writeFileSync(join(scratch, "docs/progress-log/2026-11-19-new-mutants.json"), text);
		const result = run();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			`docs/progress-log/2026-11-19-new-mutants.json: the sampler refuses it: ${refusalOf(text)}`,
		);
	});

	it("exits 0 for a well-formed inventory beside a Markdown entry", () => {
		commitMain();
		writeFileSync(join(scratch, "docs/progress-log", readableName), readable);
		writeFileSync(join(scratch, "docs/progress-log/2026-11-18-entry.md"), "# An entry\n");
		const result = run();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});

	it("exits 1 for an entry added to main's list", () => {
		writeFileSync(join(scratch, "docs/progress-log/2026-11-01-old-mutants.json"), malformed());
		commitMain();
		writeFileSync(
			join(scratch, ".unreadable-inventories.json"),
			JSON.stringify({ version2: [{ file: "2026-11-01-old-mutants.json", pullRequest: 1 }], legacy: [] }),
		);
		const result = run();
		expect(result.stderr).toContain("2026-11-01-old-mutants.json is not on main's list");
		expect(result.status).toBe(1);
	});

	it("exits 1 for a listed inventory edited since main, and 0 while it is as main has it", () => {
		const name = "2026-11-01-old-mutants.json";
		writeFileSync(join(scratch, "docs/progress-log", name), malformed());
		writeFileSync(
			join(scratch, ".unreadable-inventories.json"),
			JSON.stringify({ version2: [{ file: name, pullRequest: 1 }], legacy: [] }),
		);
		commitMain();
		expect(run().status).toBe(0);
		writeFileSync(join(scratch, "docs/progress-log", name), JSON.stringify({ melianMutants: 2, mutants: [] }));
		const result = run();
		expect(result.stderr).toContain(`lists ${name}, but it differs from main's copy`);
		expect(result.status).toBe(1);
	});

	it("exits 0 when main has the listed inventory but no list yet, as when the list first lands", () => {
		const name = "2026-11-01-old-mutants.json";
		rmSync(join(scratch, ".unreadable-inventories.json"));
		writeFileSync(join(scratch, "docs/progress-log", name), malformed());
		commitMain();
		writeFileSync(
			join(scratch, ".unreadable-inventories.json"),
			JSON.stringify({ version2: [{ file: name, pullRequest: 1 }], legacy: [] }),
		);
		const result = run();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});

	it("writes a file name's control and bidi characters as visible escapes", () => {
		commitMain();
		writeFileSync(join(scratch, "docs/progress-log", "evil\u001b[2J\r\u202eFORGED.json"), "{");
		const result = run();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("docs/progress-log/evil\\u001b[2J\\u000d\\u202eFORGED.json is not JSON");
		expect(result.stderr).not.toMatch(/[\u001b\r\u202e]/);
	});

	it("exits 1 when it cannot read origin/main", () => {
		git("init", "-q");
		const result = run();
		expect(result.stderr).toContain("cannot read origin/main");
		expect(result.status).toBe(1);
	});
});
