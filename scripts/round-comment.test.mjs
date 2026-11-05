import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fenced, marker, RoundComment } from "./round-comment.mjs";

const script = fileURLToPath(new URL("./round-comment.mjs", import.meta.url));
const goldenText = fileURLToPath(new URL("../packages/core/test/golden/verdict.txt", import.meta.url));
const goldenJson = fileURLToPath(new URL("../packages/core/test/golden/verdict.json", import.meta.url));
const run = "https://github.com/melian-agent/melian/actions/runs/1";
const head = "0123456789abcdef0123456789abcdef01234567";
const ids = (({ findings }) => [...findings.block, ...findings.acknowledge].map((finding) => finding.properties.id))(
	JSON.parse(readFileSync(goldenJson, "utf8")),
);
const header = `${marker}\nMelian round on \`0123456789ab\`, exit 2: [run](${run})`;
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

function verdict(findings, status = "findings") {
	return { status, findings: { block: [], acknowledge: [], advisory: [], silent: [], ...findings }, notRun: [] };
}

describe("RoundComment", () => {
	it("quotes the verdict line, the checks that did not run, and every block and acknowledge finding", () => {
		expect(RoundComment.read(goldenText, goldenJson, "2", run, head).body()).toBe(
			[
				header,
				"",
				"```text",
				"Verdict: not reviewed, blocking",
				"",
				"3 checks did not run:",
				"  lens.security  failed at deep: the lens did not finish",
				"    Error: provider returned 529",
				"  lens.tests  ended at quick: its token budget of 50,000 ran out after 4 tool calls and 51,200 tokens",
				"  static.tsc  skipped: no tsconfig.json at the base revision",
				"",
				"Above advisory: 4",
				`  P0 block  src/run.ts:40  lens.security  sql-injection  ${ids[0]}  The query interpolates the user's name`,
				`  P1 block  src/run.ts:12  lens.security  no-eval  ${ids[1]}  eval runs request input`,
				`  P1 block  src/run.ts:50  lens.security  no-eval  ${ids[2]}  eval runs a stored template`,
				`  P2 acknowledge  src/total.ts:9  lens.security  missing-test  ${ids[3]}  No test covers the new branch`,
				"```",
				"",
			].join("\n"),
		);
	});

	it("says there is nothing above advisory when only advisory and silent findings stand", () => {
		const comment = new RoundComment({
			text: "Verdict: findings\n\nmelian/review: success (1 advisory).\n\nAdvisory: 1 finding\n",
			verdict: verdict({
				advisory: [finding({ resolution: "advisory" })],
				silent: [finding({ resolution: "silent" })],
			}),
			exitCode: "3",
			runUrl: run,
			head,
		});
		expect(comment.body()).toBe(
			`${header.replace("exit 2", "exit 3")}\n\n\`\`\`text\nVerdict: findings\n\nNo findings above advisory.\n\`\`\`\n`,
		);
	});

	it("quotes a provisional block apart from the checks that did not run", () => {
		const text = [
			"Verdict: not reviewed",
			"",
			"melian/review: error (Not reviewed).",
			"",
			"Provisional:",
			"  static.mutation  reused an earlier head's results",
			"",
			"1 check did not run:",
			"  lens.tests  failed: the lens did not finish",
			"",
			"No findings.",
		].join("\n");
		const body = new RoundComment({
			text,
			verdict: verdict({}, "not-reviewed"),
			exitCode: "2",
			runUrl: run,
			head,
		}).body();
		expect(body).toBe(
			[
				header,
				"",
				"```text",
				"Verdict: not reviewed",
				"",
				"Provisional:",
				"  static.mutation  reused an earlier head's results",
				"",
				"1 check did not run:",
				"  lens.tests  failed: the lens did not finish",
				"",
				"No findings above advisory.",
				"```",
				"",
			].join("\n"),
		);
	});

	it("keeps a did-not-run block that ends the output, with no blank line after it", () => {
		const text = "Verdict: not reviewed\n\n2 checks did not run:\n  lens.a  failed: x\n  lens.b  failed: y";
		const body = new RoundComment({ text, verdict: undefined, exitCode: "2", runUrl: run, head }).body();
		expect(body).toContain(
			"2 checks did not run:\n  lens.a  failed: x\n  lens.b  failed: y\n\nNo findings above advisory.",
		);
	});

	it("says the round ended before a verdict when the output has no verdict line", () => {
		for (const text of ["", "melian: melian.yaml does not parse\n", "  Verdict: indented, so a finding's text\n"]) {
			expect(new RoundComment({ text, verdict: undefined, exitCode: "none", runUrl: run, head }).body()).toBe(
				`${header.replace("exit 2", "exit none")}\n\nThe round ended before it decided a verdict. The run's log and summary say why.\n`,
			);
		}
	});

	it("names a finding's lines as a range, a single line, or the file alone", () => {
		const findings = [
			finding({ id: "1111111111111111", resolution: "block", region: { startLine: 3, endLine: 7 } }),
			finding({ id: "2222222222222222", resolution: "block", region: { startLine: 4 } }),
			finding({ id: "3333333333333333", resolution: "acknowledge", severity: "P2" }),
		];
		const body = new RoundComment({
			text: "Verdict: findings, blocking\n",
			verdict: verdict({ block: findings.slice(0, 2), acknowledge: findings.slice(2) }),
			exitCode: "1",
			runUrl: run,
			head,
		}).body();
		expect(body).toContain(
			[
				"Above advisory: 3",
				"  P1 block  src/a.ts:3-7  lens.correctness  rule-a  1111111111111111  A defect",
				"  P1 block  src/a.ts:4  lens.correctness  rule-a  2222222222222222  A defect",
				"  P2 acknowledge  src/a.ts  lens.correctness  rule-a  3333333333333333  A defect",
				"```",
			].join("\n"),
		);
	});

	it("keeps a finding's text inside the fence, whatever backticks, newlines or controls it holds", () => {
		const text = "Closes the fence ````\n@maintainer [x](https://evil)\u001b[2J‮";
		const body = new RoundComment({
			text: "Verdict: findings, blocking\n",
			verdict: verdict({ block: [finding({ resolution: "block", text })] }),
			exitCode: "1",
			runUrl: run,
			head,
		}).body();
		expect(body).toBe(
			[
				header.replace("exit 2", "exit 1"),
				"",
				"`````text",
				"Verdict: findings, blocking",
				"",
				"Above advisory: 1",
				"  P1 block  src/a.ts  lens.correctness  rule-a  aaaaaaaaaaaaaaaa  Closes the fence ```` @maintainer [x](https://evil)\\u001b[2J\\u202e",
				"`````",
				"",
			].join("\n"),
		);
	});

	it("reads absent files as an empty round with no verdict", () => {
		const dir = directory();
		const comment = RoundComment.read(join(dir, "round.txt"), join(dir, "verdict.json"), "none", run, head);
		expect(comment.text).toBe("");
		expect(comment.verdict).toBeUndefined();
	});
});

describe("fenced", () => {
	const lines = ["a".repeat(10), "b".repeat(10), "c".repeat(10)];
	const whole = "```text\naaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n```\n";

	it("keeps every line that fits, at the budget and one past it", () => {
		// The room is the budget less both fences and 100 for the note: 33 characters of lines need a budget of 139.
		expect(fenced(lines, 139)).toBe(whole);
		expect(fenced(lines, 138)).toBe(
			"```text\naaaaaaaaaa\nbbbbbbbbbb\n... 1 more lines; the run's artefact has them all.\n```\n",
		);
	});

	it("keeps every line with no budget, and opens with a fence of three for a body with no backticks", () => {
		expect(fenced(lines)).toBe(whole);
		expect(fenced(["one `tick` and ``two``"])).toBe("```text\none `tick` and ``two``\n```\n");
	});
});

describe("the command", () => {
	it("prints a comment from files, and refuses to run without every argument", () => {
		const ran = spawnSync(process.execPath, [script, goldenText, goldenJson, "2", run, head], { encoding: "utf8" });
		expect(ran.status).toBe(0);
		expect(ran.stdout).toBe(RoundComment.read(goldenText, goldenJson, "2", run, head).body());
		const short = spawnSync(process.execPath, [script, goldenText, goldenJson, "2", run], { encoding: "utf8" });
		expect(short.status).toBe(64);
		expect(short.stderr).toBe(
			"usage: node scripts/round-comment.mjs <round.txt> <verdict.json> <exit> <run URL> <head>\n",
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
	});
});
