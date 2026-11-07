import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fenced, marker, maxLength, RoundComment } from "./round.mjs";

const script = fileURLToPath(new URL("./round-comment.mjs", import.meta.url));
const goldenJson = fileURLToPath(new URL("../packages/core/test/golden/verdict.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenJson, "utf8"));
const run = "https://github.com/melian-agent/melian/actions/runs/1";
const nonce = "0123456789abcdef0123456789abcdef";
const base = "b".repeat(40);
const head = "0123456789abcdef0123456789abcdef01234567";
const ids = [...golden.findings.block, ...golden.findings.acknowledge].map((finding) => finding.properties.id);
const header = (exit) =>
	`${marker("1", nonce)}\nMelian round on \`bbbbbbbbbbbb\`...\`0123456789ab\`, exit ${exit}: [run](${run})`;
const scratch = [];

function directory() {
	const dir = mkdtempSync(join(tmpdir(), "round-comment-"));
	scratch.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function finding({ id = "aaaaaaaaaaaaaaaa", resolution, severity = "P1", text = "A defect", region }) {
	return {
		ruleId: "rule-a",
		message: { text },
		locations: region === undefined ? [] : [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region } }],
		properties: { id, path: "src/a.ts", severity, resolution, source: { check: "lens.correctness" } },
	};
}

function verdict({ status = "findings", blocking = false, notRun = [], ran, ...findings } = {}) {
	return {
		status,
		blocking,
		findings: { block: [], acknowledge: [], advisory: [], silent: [], ...findings },
		notRun,
		...(ran === undefined ? {} : { ran }),
	};
}

const mergeBase = "e".repeat(40);
const comment = (value, exitCode, current = { base, head }, reviewed = { base: mergeBase, head }) =>
	new RoundComment({
		verdict: value,
		exitCode,
		runUrl: run,
		runId: "1",
		nonce,
		base,
		head,
		mergeBase,
		reviewed,
		current,
	}).body();

function roundsFile(rounds = [{ base: mergeBase, head }]) {
	const path = join(directory(), "rounds.json");
	writeFileSync(path, typeof rounds === "string" ? rounds : JSON.stringify(rounds));
	return path;
}

const read = (options) =>
	RoundComment.read({
		verdict: goldenJson,
		rounds: roundsFile(),
		exitCode: "2",
		runUrl: run,
		runId: "1",
		nonce,
		base,
		head,
		mergeBase,
		current: { base, head },
		...options,
	});
const local = "A local run of melian review shows why each check did not run.";
const fence = (exit, lines) => `${header(exit)}\n\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n`;

describe("RoundComment", () => {
	it("renders the verdict, the checks that did not run, and every block and acknowledge finding from the JSON", () => {
		expect(read().body()).toBe(
			fence(2, [
				"Verdict: not reviewed, blocking",
				"",
				"3 checks did not run:",
				"  lens.security  failed",
				"  lens.tests  ended",
				"  static.tsc  skipped",
				local,
				"",
				"Above advisory: 4",
				`  P0 block  src/run.ts:40  lens.security  sql-injection  ${ids[0]}  The query interpolates the user's name`,
				"    Why here: This change passes the name straight from the request.",
				"    What to do: Pass the name as a bound parameter.",
				`  P1 block  src/run.ts:12  lens.security  no-eval  ${ids[1]}  eval runs request input`,
				"    Why here: This change routes the body into run() without parsing it.",
				"    What to do: Parse the body with JSON.parse and validate it.",
				`  P1 block  src/run.ts:50  lens.security  no-eval  ${ids[2]}  eval runs a stored template`,
				"    Why here: This change lets users edit that template.",
				"    What to do: Render the template with a sandboxed engine.",
				`  P2 acknowledge  src/total.ts:9  lens.security  missing-test  ${ids[3]}  No test covers the new branch`,
				"    Why here: This change adds the branch.",
				"    What to do: Add a test with a total above the limit.",
			]),
		);
	});

	it("reports a not-reviewed verdict as not reviewed, whatever else the run printed", () => {
		const value = verdict({ status: "not-reviewed", notRun: [{ name: "lens.tests", status: "failed" }] });
		expect(comment(value, "2")).toBe(
			fence(2, [
				"Verdict: not reviewed",
				"",
				"1 check did not run:",
				"  lens.tests  failed",
				local,
				"",
				"No findings above advisory.",
			]),
		);
	});

	it("renders each status at the exit code melian gives it", () => {
		expect(comment(verdict({ status: "passed" }), "0")).toBe(
			fence(0, ["Verdict: passed", "", "No findings above advisory."]),
		);
		expect(comment(verdict(), "3")).toBe(fence(3, ["Verdict: findings", "", "No findings above advisory."]));
		expect(comment(verdict({ blocking: true }), "1")).toBe(
			fence(1, ["Verdict: findings, blocking", "", "No findings above advisory."]),
		);
	});

	it("reads a verdict whose exit code disagrees with its status as not reviewed", () => {
		const cases = [
			[verdict({ status: "passed" }), "2", "melian exited 2, which does not match a verdict that reads passed"],
			[
				verdict({ status: "not-reviewed" }),
				"0",
				"melian exited 0, which does not match a verdict that reads not reviewed",
			],
			[
				verdict({ blocking: true }),
				"3",
				"melian exited 3, which does not match a verdict that reads findings, blocking",
			],
			[verdict(), "1", "melian exited 1, which does not match a verdict that reads findings"],
			[
				verdict({ status: "passed" }),
				"none",
				"melian exited none, which does not match a verdict that reads passed",
			],
		];
		for (const [value, exit, problem] of cases) {
			expect(comment(value, exit)).toBe(
				fence(exit, ["Verdict: not reviewed", "", `${problem}; a local run of melian review says why.`]),
			);
		}
	});

	it("reads a missing or malformed verdict as not reviewed, naming what is wrong", () => {
		const { findings, ...noFindings } = verdict();
		const cases = [
			[undefined, "melian wrote no verdict"],
			[null, "melian wrote no verdict"],
			["Verdict: passed", "melian wrote no verdict"],
			[{ ...verdict(), status: "clean" }, "the verdict names no known status"],
			[{ ...verdict(), status: "toString" }, "the verdict names no known status"],
			[{ ...verdict(), blocking: "no" }, "the verdict does not say whether it blocks"],
			[noFindings, "the verdict holds no findings"],
			[{ ...verdict(), findings: null }, "the verdict holds no findings"],
			[{ ...verdict(), findings: { acknowledge: [] } }, "the verdict holds no block or acknowledge findings"],
			[{ ...verdict(), findings: { block: [] } }, "the verdict holds no block or acknowledge findings"],
			[{ ...verdict(), notRun: undefined }, "the verdict does not list the checks that did not run"],
		];
		for (const [value, problem] of cases) {
			expect(comment(value, "3"), problem).toBe(
				fence(3, ["Verdict: not reviewed", "", `${problem}; a local run of melian review says why.`]),
			);
		}
	});

	it("reads a verdict file that is absent or not JSON as no verdict", () => {
		const dir = directory();
		writeFileSync(join(dir, "verdict.json"), "Verdict: passed\n");
		expect(read({ verdict: join(dir, "absent.json"), exitCode: "0" }).verdict).toBeUndefined();
		expect(read({ verdict: join(dir, "verdict.json"), exitCode: "0" }).verdict).toBeNull();
	});

	it("lists provisional checks apart from the checks that did not run, by name and status alone", () => {
		const value = verdict({
			status: "not-reviewed",
			notRun: [
				{ name: "static.mutation", status: "provisional", reason: "reused an earlier head's results" },
				{
					name: "lens.a",
					status: "ended",
					level: "careful",
					budgetEnded: { budget: "tools", limit: 90, tokens: 12_000, tools: 90 },
					reason: "a note",
				},
				{ name: "lens.b", status: "skipped" },
			],
		});
		expect(comment(value, "2")).toBe(
			fence(2, [
				"Verdict: not reviewed",
				"",
				"Provisional:",
				"  static.mutation  provisional",
				local,
				"",
				"2 checks did not run:",
				"  lens.a  ended",
				"  lens.b  skipped",
				local,
				"",
				"No findings above advisory.",
			]),
		);
	});

	it("lists every check that ran or did not run off the committed routes", () => {
		const value = verdict({
			status: "not-reviewed",
			ran: [
				{
					name: "lens.design",
					status: "ran",
					lineage: {
						model: "anthropic/claude-opus-5-5",
						wanted: "openai-codex/gpt-5.6-sol",
						by: "derived",
						outside: false,
					},
				},
				{ name: "lens.tests", status: "ran" },
			],
			notRun: [
				{
					name: "lens.a",
					status: "failed",
					lineage: { model: "openai/gpt-5.5", by: "melian.local.yaml", outside: true },
				},
			],
		});
		expect(comment(value, "2")).toBe(
			fence(2, [
				"Verdict: not reviewed",
				"",
				"1 check did not run:",
				"  lens.a  failed",
				local,
				"",
				"2 checks left the committed routes:",
				"  lens.design  on anthropic/claude-opus-5-5, derived, since no model of its route has credentials, where policy wants openai-codex/gpt-5.6-sol and accepts anthropic/claude-opus-5-5",
				"  lens.a  on openai/gpt-5.5, set by melian.local.yaml, where policy does not accept openai/gpt-5.5",
				"",
				"No findings above advisory.",
			]),
		);
	});

	it("escapes U+061C in a finding's text, as core's visibleText does", () => {
		const text = `left${String.fromCharCode(0x061c)}right`;
		const body = comment(verdict({ blocking: true, block: [finding({ resolution: "block", text })] }), "1");
		expect(body).toContain("  P1 block  src/a.ts  lens.correctness  rule-a  aaaaaaaaaaaaaaaa  left\\u061cright\n");
	});

	it("says there is nothing above advisory when only advisory and silent findings stand", () => {
		const value = verdict({
			advisory: [finding({ resolution: "advisory" })],
			silent: [finding({ resolution: "silent" })],
		});
		expect(comment(value, "3")).toBe(fence(3, ["Verdict: findings", "", "No findings above advisory."]));
	});

	it("names a finding's lines as a range, a single line, or the file alone", () => {
		const value = verdict({
			blocking: true,
			block: [
				finding({ id: "1111111111111111", resolution: "block", region: { startLine: 3, endLine: 7 } }),
				finding({ id: "2222222222222222", resolution: "block", region: { startLine: 4 } }),
			],
			acknowledge: [finding({ id: "3333333333333333", resolution: "acknowledge", severity: "P2" })],
		});
		expect(comment(value, "1")).toBe(
			fence(1, [
				"Verdict: findings, blocking",
				"",
				"Above advisory: 3",
				"  P1 block  src/a.ts:3-7  lens.correctness  rule-a  1111111111111111  A defect",
				"  P1 block  src/a.ts:4  lens.correctness  rule-a  2222222222222222  A defect",
				"  P2 acknowledge  src/a.ts  lens.correctness  rule-a  3333333333333333  A defect",
			]),
		);
	});

	it("keeps a finding's text and a check's name inside the fence, whatever backticks, newlines or controls they hold", () => {
		const text = `Closes the fence \`\`\`\`\n@maintainer [x](https://evil)\u001b[2J${String.fromCharCode(0x202e)}`;
		const value = verdict({
			blocking: true,
			block: [finding({ resolution: "block", text })],
			notRun: [{ name: "lens.a\r\nb", status: "failed", error: "line one\r\nline two" }],
			status: "not-reviewed",
		});
		expect(comment(value, "2")).toBe(
			[
				header(2),
				"",
				"```text",
				"Verdict: not reviewed, blocking",
				"",
				"1 check did not run:",
				"  lens.a b  failed",
				local,
				"",
				"Above advisory: 1",
				"  P1 block  src/a.ts  lens.correctness  rule-a  aaaaaaaaaaaaaaaa  Closes the fence \\u0060\\u0060\\u0060\\u0060 @maintainer [x](https://evil)\\u001b[2J\\u202e",
				"```",
				"",
			].join("\n"),
		);
	});

	it("cuts the longest detail first to fit the limit, and says each cut", () => {
		const detailed = (id, why) => ({
			...finding({ id, resolution: "block", region: { startLine: 1 } }),
			properties: {
				...finding({ id, resolution: "block" }).properties,
				explanation: { whyHere: why, whatToDo: "Fix it" },
				failureScenario: "It fails",
			},
		});
		const value = verdict({
			blocking: true,
			block: [detailed("aaaaaaaaaaaaaaaa", "w".repeat(40_000)), detailed("bbbbbbbbbbbbbbbb", "v".repeat(30_000))],
		});
		const body = comment(value, "1");
		expect(body.length).toBeLessThanOrEqual(maxLength);
		const cut = "    Why here: cut to fit the comment's limit; a local run shows it.";
		expect(body.split("\n").filter((line) => line === cut)).toHaveLength(1);
		expect(body).toContain(`    Why here: ${"v".repeat(30_000)}\n`);
		expect(body).not.toContain("w".repeat(100));
		expect(body).toContain("    What to do: Fix it\n");
		expect(body).not.toContain("more lines; a local run shows them all.");
	});

	it("keeps a full comment under GitHub's limit of 65,536 characters, at a budget of 60,000", () => {
		expect(maxLength).toBe(60_000);
		const body = comment(
			verdict({ blocking: true, block: [finding({ resolution: "block", text: "x".repeat(70_000) })] }),
			"1",
		);
		expect(body.length).toBeLessThanOrEqual(65_536);
		expect(body).toContain("... 1 more lines; a local run shows them all.");
	});

	it("keeps a comment within its limit when a finding holds a run of backticks longer than the limit allows", () => {
		const text = "`".repeat(40_000);
		const body = comment(verdict({ blocking: true, block: [finding({ resolution: "block", text })] }), "1");
		expect(body.length).toBeLessThanOrEqual(maxLength);
		expect(body).toContain("Verdict: findings, blocking");
	});

	it("fills a comment to exactly its limit, and cuts a finding that would pass it", () => {
		const body = (length) =>
			comment(verdict({ blocking: true, block: [finding({ resolution: "block", text: "x".repeat(length) })] }), "1");
		const room = maxLength - body(0).length;
		expect(body(room)).toHaveLength(maxLength);
		expect(body(room)).not.toContain("more lines");
		expect(body(room + 1)).toContain("... 1 more lines; a local run shows them all.");
		expect(body(room + 1).length).toBeLessThanOrEqual(maxLength);
	});

	it("prints an exit code that is not a number or none as unknown, outside the fence", () => {
		const exit = (exitCode) => comment(verdict({ status: "passed" }), exitCode).split("\n")[1];
		expect(exit("0\n\nVerdict: passed")).toBe(
			`Melian round on \`bbbbbbbbbbbb\`...\`0123456789ab\`, exit unknown: [run](${run})`,
		);
		expect(exit("1234")).toBe(`Melian round on \`bbbbbbbbbbbb\`...\`0123456789ab\`, exit unknown: [run](${run})`);
		expect(exit("")).toBe(`Melian round on \`bbbbbbbbbbbb\`...\`0123456789ab\`, exit unknown: [run](${run})`);
		expect(exit("255")).toBe(`Melian round on \`bbbbbbbbbbbb\`...\`0123456789ab\`, exit 255: [run](${run})`);
		expect(exit("none")).toBe(`Melian round on \`bbbbbbbbbbbb\`...\`0123456789ab\`, exit none: [run](${run})`);
	});

	it("posts no findings for a pull request whose base or head moved during the round", () => {
		const blocking = verdict({ blocking: true, block: [finding({ resolution: "block" })] });
		const moved = (to) =>
			`${header(1)}\n\nThe pull request moved to ${to} during the round, so this round posts no findings. Start a new round.\n`;
		expect(comment(blocking, "1", { base: "c".repeat(40), head })).toBe(moved("`cccccccccccc`...`0123456789ab`"));
		expect(comment(blocking, "1", { base, head: "d".repeat(40) })).toBe(moved("`bbbbbbbbbbbb`...`dddddddddddd`"));
	});

	it("posts no findings for a verdict on a head or base other than the gate approved", () => {
		const blocking = verdict({ blocking: true, block: [finding({ resolution: "block" })] });
		const other = (to) =>
			`${header(1)}\n\nMelian reviewed ${to}, not the pull request the gate approved, so this round posts no findings. Start a new round.\n`;
		expect(comment(blocking, "1", { base, head }, { base: mergeBase, head: "d".repeat(40) })).toBe(
			other("`eeeeeeeeeeee`...`dddddddddddd`"),
		);
		expect(comment(blocking, "1", { base, head }, { base, head })).toBe(other("`bbbbbbbbbbbb`...`0123456789ab`"));
	});

	it("posts no findings when the round's record of what it reviewed cannot be read", () => {
		const unread = `${header(1)}\n\nThe round's own record of what it reviewed could not be read, so this round posts no findings. Start a new round.\n`;
		const blocking = verdict({ blocking: true, block: [finding({ resolution: "block" })] });
		const current = { base, head };
		expect(
			new RoundComment({
				verdict: blocking,
				exitCode: "1",
				runUrl: run,
				runId: "1",
				nonce,
				base,
				head,
				mergeBase,
				current,
			}).body(),
		).toBe(unread);
		for (const rounds of ["not json", "{}", [], [{ base: mergeBase }], [{ head }], [{ base: mergeBase, head: 7 }]]) {
			const body = read({ verdict: goldenJson, rounds: roundsFile(rounds), exitCode: "1" });
			expect(body.reviewed, JSON.stringify(rounds)).toBeUndefined();
		}
		expect(read({ rounds: join(directory(), "absent.json") }).reviewed).toBeUndefined();
	});

	it("reads what the last round listed reviewed", () => {
		const rounds = roundsFile([
			{ base: "1".repeat(40), head: "2".repeat(40) },
			{ base: mergeBase, head, status: "findings" },
		]);
		expect(read({ rounds }).reviewed).toEqual({ base: mergeBase, head });
	});

	it("posts no findings when the pull request could not be read again before posting", () => {
		const body = new RoundComment({
			verdict: verdict({ status: "passed" }),
			exitCode: "0",
			runUrl: run,
			runId: "1",
			nonce,
			base,
			head,
		}).body();
		expect(body).toBe(
			`${header(0)}\n\nThe pull request could not be read again before posting, so this round posts no findings. Start a new round.\n`,
		);
	});

	it("names a commit that is not a full SHA as unreadable, outside the fence", () => {
		const body = new RoundComment({
			verdict: verdict({ status: "passed" }),
			exitCode: "0",
			runUrl: run,
			base: "main",
			head: `${head.slice(0, 39)}g`,
			current: { base: "main", head: `${head.slice(0, 39)}g` },
		}).body();
		expect(body.split("\n")[1]).toBe(
			`Melian round on an unreadable commit...an unreadable commit, exit 0: [run](${run})`,
		);
		for (const sha of [`${"a".repeat(40)}z`, `z${"a".repeat(40)}`]) {
			const longer = new RoundComment({
				verdict: verdict({ status: "passed" }),
				exitCode: "0",
				runUrl: run,
				base: sha,
				head,
				current: { base: sha, head },
			}).body();
			expect(longer.split("\n")[1], sha).toBe(
				`Melian round on an unreadable commit...\`0123456789ab\`, exit 0: [run](${run})`,
			);
		}
	});

	it("opens with a marker naming its run and its nonce, by which a rerun finds the comment", () => {
		expect(
			comment(undefined, "none").startsWith(`<!-- melian-round run:1 nonce:${nonce} -->\nMelian round on `),
		).toBe(true);
		expect(marker("12345", nonce)).toBe(`<!-- melian-round run:12345 nonce:${nonce} -->`);
		for (const runId of ["", "12a", "1 2", undefined])
			expect(marker(runId, nonce), String(runId)).toBe(`<!-- melian-round run:unknown nonce:${nonce} -->`);
		for (const bad of [
			"",
			`${nonce}0`,
			`0${nonce}`,
			nonce.slice(1),
			nonce.toUpperCase(),
			`${nonce.slice(1)}g`,
			undefined,
		])
			expect(marker("1", bad), String(bad)).toBe("<!-- melian-round run:1 nonce:unknown -->");
	});
});

describe("fenced", () => {
	const lines = ["a".repeat(100), "b".repeat(100), "c".repeat(100)];
	const whole = `\`\`\`text\n${lines.join("\n")}\n\`\`\`\n`;
	const note = (count) => `... ${count} more lines; a local run shows them all.`;
	const cut = (kept) => `\`\`\`text\n${[...lines.slice(0, kept), note(lines.length - kept)].join("\n")}\n\`\`\`\n`;

	it("keeps every line at a budget of exactly its length, and cuts one past it", () => {
		expect(whole).toHaveLength(315);
		expect(fenced(lines, 315)).toBe(whole);
		expect(fenced(lines, 314)).toBe(cut(2));
	});

	it("keeps as many lines as fit beside the note, at that bound and one past it", () => {
		expect(fenced(lines, cut(2).length)).toBe(cut(2));
		expect(fenced(lines, cut(2).length - 1)).toBe(cut(1));
		expect(fenced(lines, cut(1).length)).toBe(cut(1));
		expect(fenced(lines, cut(1).length - 1)).toBe(cut(0));
	});

	it("keeps only the note when no line fits beside it", () => {
		expect(fenced(lines, 10)).toBe(cut(0));
	});

	it("keeps every line with no budget, and opens with a fence of three for a body with no backticks", () => {
		expect(fenced(lines)).toBe(whole);
		expect(fenced(["one `tick` and ``two``"])).toBe("```text\none `tick` and ``two``\n```\n");
	});

	it("writes a run of three or more backticks as escapes, so the fence stays at three", () => {
		const escaped = (count) => "\\u0060".repeat(count);
		expect(fenced(["x `` y", "x ``` y", "````"])).toBe(
			`\`\`\`text\nx \`\` y\nx ${escaped(3)} y\n${escaped(4)}\n\`\`\`\n`,
		);
	});

	it("measures the escaped lines against the budget", () => {
		const body = ["x ````", "y".repeat(100)];
		const out = `\`\`\`text\nx ${"\\u0060".repeat(4)}\n${"y".repeat(100)}\n\`\`\`\n`;
		expect(fenced(body, out.length)).toBe(out);
		expect(fenced(body, out.length - 1)).toBe(`\`\`\`text\nx ${"\\u0060".repeat(4)}\n${note(1)}\n\`\`\`\n`);
	});
});

describe("the command", () => {
	it("prints a comment from its files, and refuses to run without every option", () => {
		const rounds = roundsFile();
		const options = [
			"--verdict",
			goldenJson,
			"--rounds",
			rounds,
			"--exit",
			"2",
			"--run-url",
			run,
			"--run-id",
			"1",
			"--nonce",
			nonce,
		];
		const commits = ["--base", base, "--head", head, "--merge-base", mergeBase];
		const current = ["--current-base", base, "--current-head", head];
		const ran = spawnSync(process.execPath, [script, ...options, ...commits, ...current], { encoding: "utf8" });
		expect([ran.status, ran.stderr]).toEqual([0, ""]);
		expect(ran.stdout).toBe(read({ rounds }).body());
		const unread = spawnSync(process.execPath, [script, ...options, ...commits], { encoding: "utf8" });
		expect(unread.stdout).toBe(read({ rounds, current: undefined }).body());
		const usage =
			"usage: node scripts/round-comment.mjs --verdict <value> --rounds <value> --exit <value> --run-url <value> --run-id <value> --nonce <value> --base <value> --head <value> --merge-base <value>\n";
		for (const short of [
			[...options, ...commits.slice(0, -2)],
			[...options, ...commits, "--unknown", "x"],
		]) {
			const refused = spawnSync(process.execPath, [script, ...short], { encoding: "utf8" });
			expect([refused.status, refused.stdout, refused.stderr]).toEqual([64, "", usage]);
		}
	});
});
