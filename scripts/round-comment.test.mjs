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
const base = "b".repeat(40);
const head = "0123456789abcdef0123456789abcdef01234567";
const ids = [...golden.findings.block, ...golden.findings.acknowledge].map((finding) => finding.properties.id);
const header = (exit) => `${marker}\nMelian round on \`bbbbbbbbbbbb\`...\`0123456789ab\`, exit ${exit}: [run](${run})`;
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

const comment = (value, exitCode, current = { base, head }) =>
	new RoundComment({ verdict: value, exitCode, runUrl: run, base, head, current }).body();
const fence = (exit, lines) => `${header(exit)}\n\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n`;

describe("RoundComment", () => {
	it("renders the verdict, the checks that did not run, and every block and acknowledge finding from the JSON", () => {
		expect(RoundComment.read(goldenJson, "2", run, base, head, { base, head }).body()).toBe(
			fence(2, [
				"Verdict: not reviewed, blocking",
				"",
				"3 checks did not run:",
				"  lens.security  failed at deep: the lens did not finish",
				"    Error: provider returned 529",
				"  lens.tests  ended at quick: its tokens budget of 50000 ran out",
				"  static.tsc  skipped: no tsconfig.json at the base revision",
				"",
				"Above advisory: 4",
				`  P0 block  src/run.ts:40  lens.security  sql-injection  ${ids[0]}  The query interpolates the user's name`,
				`  P1 block  src/run.ts:12  lens.security  no-eval  ${ids[1]}  eval runs request input`,
				`  P1 block  src/run.ts:50  lens.security  no-eval  ${ids[2]}  eval runs a stored template`,
				`  P2 acknowledge  src/total.ts:9  lens.security  missing-test  ${ids[3]}  No test covers the new branch`,
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
				fence(exit, ["Verdict: not reviewed", "", `${problem}; the run's log and artefact say why.`]),
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
				fence(3, ["Verdict: not reviewed", "", `${problem}; the run's log and artefact say why.`]),
			);
		}
	});

	it("reads a verdict file that is absent or not JSON as no verdict", () => {
		const dir = directory();
		writeFileSync(join(dir, "verdict.json"), "Verdict: passed\n");
		for (const path of [join(dir, "absent.json"), join(dir, "verdict.json")]) {
			expect(RoundComment.read(path, "0", run, base, head, { base, head }).verdict).toBeUndefined();
		}
	});

	it("lists provisional checks apart from the checks that did not run, each with its level, reason and budget", () => {
		const value = verdict({
			status: "not-reviewed",
			notRun: [
				{ name: "static.mutation", status: "provisional", reason: "reused an earlier head's results" },
				{
					name: "lens.a",
					status: "ended",
					level: "careful",
					budgetEnded: { budget: "tools", limit: 90 },
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
				"  static.mutation  provisional: reused an earlier head's results",
				"",
				"2 checks did not run:",
				"  lens.a  ended at careful: its tools budget of 90 ran out; a note",
				"  lens.b  skipped",
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
					lineage: { model: "anthropic/claude-opus-5-5", wanted: "openai-codex/gpt-5.6-sol" },
				},
				{ name: "lens.tests", status: "ran" },
			],
			notRun: [{ name: "lens.a", status: "failed", lineage: { model: "openai/gpt-5.5", outside: true } }],
		});
		expect(comment(value, "2")).toBe(
			fence(2, [
				"Verdict: not reviewed",
				"",
				"1 check did not run:",
				"  lens.a  failed",
				"",
				"2 checks left the committed routes:",
				"  lens.design  on anthropic/claude-opus-5-5, where policy wants openai-codex/gpt-5.6-sol",
				"  lens.a  on openai/gpt-5.5, outside what policy accepts",
				"",
				"No findings above advisory.",
			]),
		);
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

	it("keeps a finding's text and a check's reason inside the fence, whatever backticks, newlines or controls they hold", () => {
		const text = `Closes the fence \`\`\`\`\n@maintainer [x](https://evil)\u001b[2J${String.fromCharCode(0x202e)}`;
		const value = verdict({
			blocking: true,
			block: [finding({ resolution: "block", text })],
			notRun: [{ name: "lens.a", status: "failed", error: "line one\r\nline two" }],
			status: "not-reviewed",
		});
		expect(comment(value, "2")).toBe(
			[
				header(2),
				"",
				"`````text",
				"Verdict: not reviewed, blocking",
				"",
				"1 check did not run:",
				"  lens.a  failed",
				"    Error: line one line two",
				"",
				"Above advisory: 1",
				"  P1 block  src/a.ts  lens.correctness  rule-a  aaaaaaaaaaaaaaaa  Closes the fence ```` @maintainer [x](https://evil)\\u001b[2J\\u202e",
				"`````",
				"",
			].join("\n"),
		);
	});

	it("keeps a full comment under GitHub's limit of 65,536 characters, at a budget of 60,000", () => {
		expect(maxLength).toBe(60_000);
		const body = comment(
			verdict({ blocking: true, block: [finding({ resolution: "block", text: "x".repeat(70_000) })] }),
			"1",
		);
		expect(body.length).toBeLessThanOrEqual(65_536);
		expect(body).toContain("... 1 more lines; the run's artefact has them all.");
	});

	it("fills a comment to exactly its limit, and cuts a finding that would pass it", () => {
		const body = (length) =>
			comment(verdict({ blocking: true, block: [finding({ resolution: "block", text: "x".repeat(length) })] }), "1");
		const room = maxLength - body(0).length;
		expect(body(room)).toHaveLength(maxLength);
		expect(body(room)).not.toContain("more lines");
		expect(body(room + 1)).toContain("... 1 more lines; the run's artefact has them all.");
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

	it("posts no findings when the pull request could not be read again before posting", () => {
		const body = new RoundComment({
			verdict: verdict({ status: "passed" }),
			exitCode: "0",
			runUrl: run,
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

	it("opens with the marker a later job counts its rounds by", () => {
		expect(comment(undefined, "none").startsWith("<!-- melian-round -->\nMelian round on ")).toBe(true);
	});
});

describe("fenced", () => {
	const lines = ["a".repeat(100), "b".repeat(100), "c".repeat(100)];
	const whole = `\`\`\`text\n${lines.join("\n")}\n\`\`\`\n`;
	const note = (count) => `... ${count} more lines; the run's artefact has them all.`;
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

	it("measures the fence it uses, not three backticks", () => {
		const body = ["x ````", "y".repeat(100)];
		const out = `\`\`\`\`\`text\nx \`\`\`\`\n${"y".repeat(100)}\n\`\`\`\`\`\n`;
		expect(fenced(body, out.length)).toBe(out);
		expect(fenced(body, out.length - 1)).toBe(`\`\`\`\`\`text\nx \`\`\`\`\n${note(1)}\n\`\`\`\`\`\n`);
	});
});

describe("the command", () => {
	it("prints a comment from the verdict file, and refuses to run without every argument", () => {
		const args = [script, goldenJson, "2", run, base, head];
		const ran = spawnSync(process.execPath, [...args, base, head], { encoding: "utf8" });
		expect(ran.status).toBe(0);
		expect(ran.stdout).toBe(RoundComment.read(goldenJson, "2", run, base, head, { base, head }).body());
		const unread = spawnSync(process.execPath, args, { encoding: "utf8" });
		expect(unread.stdout).toBe(RoundComment.read(goldenJson, "2", run, base, head, undefined).body());
		const short = spawnSync(process.execPath, args.slice(0, -1), { encoding: "utf8" });
		expect(short.status).toBe(64);
		expect(short.stderr).toBe(
			"usage: node scripts/round-comment.mjs <verdict.json> <exit> <run URL> <base> <head> [<base> <head>]\n",
		);
	});

	it("fences a file for the job summary with its controls escaped, and says so when it is absent or empty", () => {
		const dir = directory();
		writeFileSync(join(dir, "round.err"), "melian: Plan: light derived\u0007\n\n");
		writeFileSync(join(dir, "empty"), "\n");
		const fence = (path) => spawnSync(process.execPath, [script, "--fence", path], { encoding: "utf8" }).stdout;
		expect(fence(join(dir, "round.err"))).toBe("```text\nmelian: Plan: light derived\\u0007\n```\n");
		expect(fence(join(dir, "empty"))).toBe("Nothing was written.\n");
		expect(fence(join(dir, "absent"))).toBe("Nothing was written.\n");
		const bare = spawnSync(process.execPath, [script, "--fence"], { encoding: "utf8" });
		expect(bare.stdout).toBe("Nothing was written.\n");
	});
});
