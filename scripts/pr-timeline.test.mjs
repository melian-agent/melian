import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOUR, KINDS, parseTiming, Timeline } from "./timeline.mjs";

const script = fileURLToPath(new URL("./pr-timeline.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/pr-timeline/pr-900.json", import.meta.url));

const fakeGh = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const answer = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, "utf8")).find(
	(request) => JSON.stringify(request.args) === JSON.stringify(args),
);
if (!answer) {
	process.stderr.write("unexpected request: " + JSON.stringify(args) + "\\n");
	process.exit(1);
}
process.stdout.write(answer.stdout);
`;

function run(args, recording = fixture) {
	const dir = mkdtempSync(join(tmpdir(), "pr-timeline-"));
	try {
		writeFileSync(join(dir, "gh"), fakeGh);
		chmodSync(join(dir, "gh"), 0o755);
		const log = join(dir, "requests.log");
		writeFileSync(log, "");
		const result = spawnSync(process.execPath, [script, ...args.map((arg) => arg.replace("$DIR", dir))], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_FIXTURE: recording, FAKE_GH_LOG: log },
		});
		const requests = readFileSync(log, "utf8").split("\n").filter(Boolean).map(JSON.parse);
		const record = join(dir, "record.json");
		const recorded = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : undefined;
		return { ...result, requests, recorded };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const expected = [
	"| Time (UTC) | Hours | Event | Detail |",
	"| --- | --- | --- | --- |",
	"| 2026-10-01 00:00 | 0.00 | issue opened | \\#901 |",
	"| 2026-10-01 00:00 | 0.00 | labelled | \\#901 status: ready |",
	"|  |  | gap | 2.0 h |",
	"| 2026-10-01 02:00 | 2.00 | Claim | \\#901 by builder |",
	"| 2026-10-01 02:00 | 2.00 | labelled | \\#901 status: in progress |",
	"| 2026-10-01 02:00 | 2.00 | unlabelled | \\#901 status: ready |",
	"| 2026-10-01 03:00 | 3.00 | commit | aaaaaaaa |",
	"|  |  | gap | 1.0 h |",
	"| 2026-10-01 04:00 | 4.00 | commit | bbbbbbbb |",
	"| 2026-10-01 04:10 | 4.17 | pull request opened | \\#900 by builder |",
	"| 2026-10-01 04:10 | 4.17 | CI check | cccccccc, success, 15.0 min |",
	"| 2026-10-01 04:20 | 4.33 | merge commit | cccccccc |",
	"| 2026-10-01 05:25 | 5.42 | comment | by builder |",
	"| 2026-10-01 05:25 | 5.42 | Timing | gate 2 × 14 min |",
	"| 2026-10-01 05:25 | 5.42 | Timing | round 1 × 6 min, $6.40 |",
	"| 2026-10-01 05:25 | 5.42 | Timing | Codex review 9 min |",
	"| 2026-10-01 05:25 | 5.42 | Timing | waited 40 min for a ruling |",
	"| 2026-10-01 05:25 | 5.42 | Timing | lunch \\| break |",
	"| 2026-10-01 05:30 | 5.50 | review | approved by maintainer |",
	"| 2026-10-01 05:40 | 5.67 | Fix pass | \\#901 by builder |",
	"| 2026-10-01 06:00 | 6.00 | commit | dddddddd |",
	"|  |  | gap | 2.0 h |",
	"| 2026-10-01 08:00 | 8.00 | ready for review |  |",
	"| 2026-10-01 08:01 | 8.02 | queued |  |",
	"| 2026-10-01 08:01 | 8.03 | CI check | merge group, success, 14.0 min |",
	"| 2026-10-01 08:16 | 8.27 | merged | eeeeeeee |",
	"| 2026-10-01 08:16 | 8.27 | left the queue | merged |",
	"",
	"| Summary | Value |",
	"| --- | --- |",
	"| Timing reported | 83 min, $6.40 |",
	"| Timing: gate | 28 min |",
	"| Timing: round | 6 min, $6.40 |",
	"| Timing: codex | 9 min |",
	"| Timing: wait | 40 min |",
	"| CI | 29.0 min over 2 runs |",
	"| total | 8.27 h |",
	"",
	"| Timing not parsed | Comment time (UTC) |",
	"| --- | --- |",
	"| lunch \\| break | 2026-10-01 05:25 |",
	"",
];

describe("pr-timeline", () => {
	it("prints a recorded pull request's whole timeline through a fake gh that answers only the expected requests", () => {
		const result = run(["900", "--repo", "octo/repo"]);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout.split("\n")).toEqual(expected);
		const recorded = JSON.parse(readFileSync(fixture, "utf8")).map((request) => request.args);
		expect(result.requests).toEqual(recorded);
	});

	it("prints the recorded table for pull request 256, with the first cut's gaps, commits, CI and span", () => {
		const recording = fileURLToPath(new URL("./fixtures/pr-timeline/pr-256.json", import.meta.url));
		const result = run(["256"], recording);
		expect(result.status).toBe(0);
		const printed = fileURLToPath(new URL("./fixtures/pr-timeline/pr-256.md", import.meta.url));
		expect(result.stdout).toBe(readFileSync(printed, "utf8"));
		const lines = result.stdout.split("\n");
		expect(lines.filter((row) => row.includes("| gap |")).map((row) => row.split("|")[4].trim())).toEqual([
			"18.2 h",
			"1.2 h",
			"1.2 h",
			"1.3 h",
			"1.2 h",
			"178.3 h",
			"1.2 h",
			"1.5 h",
			"2.3 h",
		]);
		expect(lines.filter((row) => /\| (merge )?commit \|/.test(row)).map((row) => row.split("|")[4].trim())).toEqual([
			"7ca5d111",
			"b88647c5",
			"fd68b824",
			"42cef9eb",
			"b6d4e8c2",
			"66236a18",
			"9b6de4a9",
			"dff453f3",
			"5318223d",
			"2d63c723",
			"bdcf9ef2",
			"414339b1",
			"f086a12d",
			"1db1fad2",
		]);
		expect(lines.slice(-6)).toEqual([
			"| Summary | Value |",
			"| --- | --- |",
			"| Timing reported | none |",
			"| CI | 159.9 min over 14 runs |",
			"| total | 212.62 h |",
			"",
		]);
	});

	it("records every request and answer with --record, in the fixture's own form", () => {
		const result = run(["900", "--repo", "octo/repo", "--record", "$DIR/record.json"]);
		expect(result.status).toBe(0);
		expect(result.recorded).toEqual(JSON.parse(readFileSync(fixture, "utf8")));
	});

	it("rejects a missing or non-numeric pull request number without calling gh", () => {
		for (const args of [[], ["abc"], ["12a"], ["a12"]]) {
			const result = run(args);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("usage:");
			expect(result.requests).toEqual([]);
		}
	});

	it("rejects an option with no value, or one it does not know, without calling gh", () => {
		for (const args of [
			["900", "--repo"],
			["900", "--record"],
			["900", "--bogus", "x"],
			["900", "901"],
		]) {
			const result = run(args);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("usage:");
			expect(result.requests).toEqual([]);
		}
	});

	it("asks about melian-agent/melian when only --record is given", () => {
		const result = run(["900", "--record", "$DIR/record.json"]);
		expect(result.requests[0].slice(4)).toEqual([
			"-F",
			"owner=melian-agent",
			"-F",
			"name=melian",
			"-F",
			"number=900",
		]);
	});
});

const page = (nodes) => ({ pageInfo: { hasNextPage: false }, nodes });
const commit = (oid, at) => ({
	commit: { oid, committedDate: new Date(at).toISOString(), parents: { totalCount: 1 } },
});
const pull = (overrides = {}) => ({
	number: 1,
	createdAt: "2026-10-01T00:00:00.000Z",
	headRefName: "b",
	baseRefName: "main",
	body: "",
	author: { login: "a" },
	closingIssuesReferences: page([]),
	commits: page([]),
	timelineItems: page([]),
	...overrides,
});
const start = Date.parse("2026-10-01T00:00:00.000Z");
const rows = (timeline) => timeline.render().split("\n");

describe("gaps", () => {
	it.each([
		{ after: HOUR, gaps: [] },
		{ after: HOUR + 1000, gaps: ["|  |  | gap | 1.0 h |"] },
	])("prints $gaps.length gap rows for a gap of $after ms", ({ after, gaps }) => {
		const commits = page([commit("1".repeat(40), start), commit("2".repeat(40), start + after)]);
		const timeline = Timeline.from({ pull: pull({ commits }), runs: [] });
		expect(rows(timeline).filter((row) => row.includes("gap"))).toEqual(gaps);
	});

	it("lets a CI run's span cover the events inside it, and measures the next gap from its end", () => {
		const commits = page([
			commit("1".repeat(40), start),
			commit("2".repeat(40), start + 2 * HOUR),
			commit("3".repeat(40), start + 4.5 * HOUR),
		]);
		const ci = {
			name: "check",
			event: "push",
			head_sha: "1".repeat(40),
			status: "completed",
			conclusion: null,
			run_started_at: new Date(start).toISOString(),
			updated_at: new Date(start + 3 * HOUR).toISOString(),
		};
		const timeline = Timeline.from({ pull: pull({ commits }), runs: [ci] });
		expect(rows(timeline).filter((row) => row.includes("gap") || row.includes("CI"))).toEqual([
			"| 2026-10-01 00:00 | 0.00 | CI check | 11111111, completed, 180.0 min |",
			"|  |  | gap | 1.5 h |",
			"| CI | 180.0 min over 1 runs |",
		]);
	});

	it("never lets a Timing item fill a gap", () => {
		const commits = page([commit("1".repeat(40), start), commit("2".repeat(40), start + 3 * HOUR)]);
		const body = "Timing: gate 5 min";
		const at = new Date(start + 2 * HOUR).toISOString();
		const timelineItems = page([{ __typename: "IssueComment", createdAt: at, body, author: null }]);
		const timeline = Timeline.from({ pull: pull({ commits, timelineItems }), runs: [] });
		expect(rows(timeline).slice(2, 8)).toEqual([
			"| 2026-10-01 00:00 | 0.00 | pull request opened | \\#1 by a |",
			"| 2026-10-01 00:00 | 0.00 | commit | 11111111 |",
			"|  |  | gap | 2.0 h |",
			"| 2026-10-01 02:00 | 2.00 | comment | by ghost |",
			"| 2026-10-01 02:00 | 2.00 | Timing | gate 5 min |",
			"| 2026-10-01 03:00 | 3.00 | commit | 22222222 |",
		]);
	});
});

describe("Timing rows", () => {
	it("reads Timing only from comments, never from the description or a review", () => {
		const at = "2026-10-01T01:00:00.000Z";
		const timelineItems = page([
			{
				__typename: "PullRequestReview",
				submittedAt: at,
				state: "APPROVED",
				body: "Timing: codex 3 min",
				author: null,
			},
			{ __typename: "IssueComment", createdAt: at, body: "Timing: round 2 min", author: { login: "b" } },
		]);
		const body = "Closes #2\n\nTiming: gate 5 min";
		const timeline = Timeline.from({ pull: pull({ body, timelineItems }), runs: [] });
		expect(rows(timeline).filter((row) => row.includes("Timing"))).toEqual([
			"| 2026-10-01 01:00 | 1.00 | Timing | round 2 min |",
			"| Timing reported | 2 min |",
			"| Timing: round | 2 min |",
		]);
		expect(rows(timeline)).toContain("| 2026-10-01 01:00 | 1.00 | review | approved by ghost |");
	});
});

describe("summary", () => {
	it("prints every claim on the issue as a row, and a summary with no Timing and no CI", () => {
		const issue = {
			number: 7,
			createdAt: "2026-10-01T00:00:00.000Z",
			timelineItems: page([
				{
					__typename: "IssueComment",
					createdAt: "2026-10-01T01:30:00.000Z",
					body: "  Claim: me",
					author: { login: "me" },
				},
				{
					__typename: "IssueComment",
					createdAt: "2026-10-01T01:45:00.000Z",
					body: "Claim: late",
					author: { login: "late" },
				},
			]),
		};
		const timeline = Timeline.from({ pull: pull({ closingIssuesReferences: page([issue]) }), runs: [] });
		expect(rows(timeline).filter((row) => row.includes("Claim"))).toEqual([
			"| 2026-10-01 01:30 | 1.50 | Claim | \\#7 by me |",
			"| 2026-10-01 01:45 | 1.75 | Claim | \\#7 by late |",
		]);
		expect(rows(timeline).slice(-6)).toEqual([
			"",
			"| Summary | Value |",
			"| --- | --- |",
			"| Timing reported | none |",
			"| CI | 0.0 min over 0 runs |",
			"| total | 1.75 h |",
		]);
	});

	it("reads Claim and Fix pass from a comment's opening paragraph, never from a code block", () => {
		const comment = (minutes, body) => ({
			__typename: "IssueComment",
			createdAt: new Date(start + minutes * 60_000).toISOString(),
			body,
			author: { login: "b" },
		});
		const issue = {
			number: 7,
			createdAt: "2026-10-01T00:00:00.000Z",
			timelineItems: page([
				comment(10, "    Claim: example only"),
				comment(20, "```\nFix pass 1, quoted\n```"),
				comment(30, ""),
				comment(40, "Claim: me"),
				comment(50, "Fix pass 2 starts."),
			]),
		};
		const timeline = Timeline.from({ pull: pull({ closingIssuesReferences: page([issue]) }), runs: [] });
		expect(rows(timeline).filter((row) => /\| (Claim|Fix pass) \|/.test(row))).toEqual([
			"| 2026-10-01 00:40 | 0.67 | Claim | \\#7 by b |",
			"| 2026-10-01 00:50 | 0.83 | Fix pass | \\#7 by b |",
		]);
	});

	it("sums every parsed Timing item's minutes and cost across comments, per kind and in all", () => {
		const comment = (hours, body) => ({
			__typename: "IssueComment",
			createdAt: new Date(start + hours * HOUR).toISOString(),
			body,
			author: { login: "b" },
		});
		const timelineItems = page([
			comment(1, "Timing: gate 2 × 14 min; round 6 min, $6.40"),
			comment(2, "Timing: waited 40.5 min for CI; lunch"),
			comment(3, "Timing: codex 1 min, $0.10"),
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		const summary = rows(timeline).slice(rows(timeline).indexOf("| Summary | Value |"));
		expect(summary).toEqual([
			"| Summary | Value |",
			"| --- | --- |",
			"| Timing reported | 75.5 min, $6.50 |",
			"| Timing: gate | 28 min |",
			"| Timing: round | 6 min, $6.40 |",
			"| Timing: codex | 1 min, $0.10 |",
			"| Timing: wait | 40.5 min |",
			"| CI | 0.0 min over 0 runs |",
			"| total | 3.00 h |",
			"",
			"| Timing not parsed | Comment time (UTC) |",
			"| --- | --- |",
			"| lunch | 2026-10-01 02:00 |",
		]);
	});

	it("reads a Timing line from a comment on the closing issue", () => {
		const issue = {
			number: 7,
			createdAt: "2026-10-01T00:00:00.000Z",
			timelineItems: page([
				{
					__typename: "IssueComment",
					createdAt: "2026-10-01T01:00:00.000Z",
					body: "Timing: gate 4 min",
					author: { login: "b" },
				},
			]),
		};
		const timeline = Timeline.from({ pull: pull({ closingIssuesReferences: page([issue]) }), runs: [] });
		expect(rows(timeline).filter((row) => row.includes("Timing"))).toEqual([
			"| 2026-10-01 01:00 | 1.00 | Timing | gate 4 min |",
			"| Timing reported | 4 min |",
			"| Timing: gate | 4 min |",
		]);
	});

	it.each([
		{ body: "Timing: round 0 min, $0.10", reported: "0 min, $0.10" },
		{ body: "Timing: lunch", reported: "none" },
	])("reports $reported for a comment reading $body", ({ body, reported }) => {
		const timelineItems = page([
			{ __typename: "IssueComment", createdAt: "2026-10-01T01:00:00.000Z", body, author: { login: "b" } },
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain(`| Timing reported | ${reported} |`);
	});

	it("totals decimal minutes exactly, with no floating-point noise", () => {
		const timelineItems = page([
			{
				__typename: "IssueComment",
				createdAt: "2026-10-01T01:00:00.000Z",
				body: "Timing: gate 3 × 0.1 min; gate 1.01 min",
				author: { login: "b" },
			},
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain("| Timing reported | 1.31 min |");
		expect(rows(timeline)).toContain("| Timing: gate | 1.31 min |");
	});

	it("sums the per-kind rows into the total exactly, so the printed rows always add up", () => {
		const timelineItems = page([
			{
				__typename: "IssueComment",
				createdAt: "2026-10-01T01:00:00.000Z",
				body: "Timing: gate 0.1 min, $0.1; codex 0.2 min, $0.2; codex 1.01 min, $1.01",
				author: { login: "b" },
			},
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain("| Timing: gate | 0.1 min, $0.10 |");
		expect(rows(timeline)).toContain("| Timing: codex | 1.21 min, $1.21 |");
		expect(rows(timeline)).toContain("| Timing reported | 1.31 min, $1.31 |");
	});

	it("totals a hundred items of 0.01 exactly, and the largest legal items without losing a hundredth", () => {
		const comment = (body) => ({
			__typename: "IssueComment",
			createdAt: "2026-10-01T01:00:00.000Z",
			body,
			author: { login: "b" },
		});
		const small = Timeline.from({
			pull: pull({
				timelineItems: page([comment(`Timing: ${Array(100).fill("gate 0.01 min, $0.01").join("; ")}`)]),
			}),
			runs: [],
		});
		expect(rows(small)).toContain("| Timing reported | 1 min, $1.00 |");
		const large = Timeline.from({
			pull: pull({
				timelineItems: page([comment("Timing: gate 999 × 999999.99 min, $999999.99; codex 0.01 min, $0.01")]),
			}),
			runs: [],
		});
		expect(rows(large)).toContain("| Timing reported | 998999990.02 min, $1000000.00 |");
	});

	it("prints minutes alone when no Timing item carries a cost", () => {
		const timelineItems = page([
			{
				__typename: "IssueComment",
				createdAt: "2026-10-01T01:00:00.000Z",
				body: "Timing: gate 5 min",
				author: { login: "b" },
			},
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain("| Timing reported | 5 min |");
	});
});

describe("fetch", () => {
	it.each(["closingIssuesReferences", "commits", "timelineItems", "issue"])(
		"refuses a pull request whose %s has a second page",
		(which) => {
			const issue = { number: 2, createdAt: "2026-10-01T00:00:00Z", timelineItems: page([]) };
			const data = pull({ closingIssuesReferences: page([issue]) });
			const target = which === "issue" ? issue.timelineItems : data[which];
			target.pageInfo.hasNextPage = true;
			const asked = [];
			const gh = (args) => {
				asked.push(args[1]);
				return JSON.stringify({ data: { repository: { pullRequest: data } } });
			};
			expect(() => Timeline.fetch({ number: 1, repo: "o/r", gh })).toThrow(
				"pull request #1 has more items than one page holds; the timeline would be incomplete",
			);
			expect(asked).toEqual(["graphql"]);
		},
	);

	const ci = (id) => ({
		name: "check",
		event: "merge_group",
		head_branch: `gh-readonly-queue/main/pr-1-${id}`,
		head_sha: id.repeat(40),
		status: "completed",
		conclusion: "success",
		run_started_at: "2026-10-01T01:00:00Z",
		updated_at: "2026-10-01T01:10:00Z",
	});
	const github = (data, answers) => {
		const asked = [];
		const gh = (args) => {
			asked.push(args);
			if (args[1] === "graphql") return JSON.stringify({ data: { repository: { pullRequest: data } } });
			if (args.includes("event=merge_group")) return JSON.stringify(answers.group ?? empty);
			const sha = args.find((arg) => arg.startsWith("head_sha="))?.slice("head_sha=".length);
			return JSON.stringify(answers.shas?.[sha] ?? empty);
		};
		return { gh, asked, queue: () => asked.find((args) => args.includes("event=merge_group")) };
	};
	const empty = [{ total_count: 0, workflow_runs: [] }];
	const merged = page([
		{ __typename: "MergedEvent", createdAt: "2026-10-02T00:00:00Z", commit: { oid: "e".repeat(40) } },
	]);

	it("searches merge-group runs only from a merged pull request's opening to its merge", () => {
		const { gh, queue } = github(pull({ timelineItems: merged }), {});
		Timeline.fetch({ number: 1, repo: "o/r", gh, now: "2026-10-09T00:00:00Z" });
		expect(queue()).toEqual([
			"api",
			"--paginate",
			"--slurp",
			"-X",
			"GET",
			"repos/o/r/actions/runs",
			"-f",
			"event=merge_group",
			"-f",
			"created=2026-10-01T00:00:00.000Z..2026-10-02T00:00:00Z",
			"-f",
			"per_page=100",
		]);
	});

	it("asks for the runs of each commit and force-push tip by SHA, with no time window", () => {
		const commits = page([commit("a".repeat(40), start), commit("b".repeat(40), start + HOUR)]);
		const timelineItems = page([
			{
				__typename: "HeadRefForcePushedEvent",
				createdAt: "2026-10-01T00:30:00Z",
				beforeCommit: { oid: "c".repeat(40) },
				afterCommit: { oid: "a".repeat(40) },
			},
			{
				__typename: "HeadRefForcePushedEvent",
				createdAt: "2026-10-01T00:40:00Z",
				beforeCommit: null,
				afterCommit: null,
			},
		]);
		const { gh, asked } = github(pull({ commits, timelineItems }), {});
		Timeline.fetch({ number: 1, repo: "o/r", gh, now: "2026-10-09T00:00:00Z" });
		const bySha = (sha) => [
			"api",
			"--paginate",
			"--slurp",
			"-X",
			"GET",
			"repos/o/r/actions/runs",
			"-f",
			`head_sha=${sha}`,
			"-f",
			"per_page=100",
		];
		expect(asked.filter((args) => args[1] !== "graphql" && !args.includes("event=merge_group"))).toEqual([
			bySha("a".repeat(40)),
			bySha("b".repeat(40)),
			bySha("c".repeat(40)),
		]);
	});

	const run = (name, extra) => ({
		name,
		event: "push",
		head_branch: "b",
		head_sha: "0".repeat(40),
		status: "completed",
		conclusion: "success",
		run_started_at: "2026-10-01T01:00:00Z",
		updated_at: "2026-10-01T01:10:00Z",
		...extra,
	});
	const ciRows = (gh) =>
		Timeline.fetch({ number: 1, repo: "o/r", gh, now: "2026-10-09T00:00:00Z" })
			.render()
			.split("\n")
			.filter((row) => /^\| \d{4}-.* \| CI /.test(row));

	it("shows the runs of each commit and force-push tip, from before the pull request opened and after it closed", () => {
		const commits = page([commit("a".repeat(40), start)]);
		const timelineItems = page([
			{
				__typename: "HeadRefForcePushedEvent",
				createdAt: "2026-10-01T00:30:00Z",
				beforeCommit: { oid: "b".repeat(40) },
				afterCommit: null,
			},
		]);
		const pages = (...runs) => [{ total_count: runs.length, workflow_runs: runs }];
		const shas = {
			["a".repeat(40)]: pages(
				run("before opening", {
					head_sha: "a".repeat(40),
					run_started_at: "2026-09-30T22:50:00Z",
					updated_at: "2026-09-30T23:00:00Z",
				}),
				run("rerun after closing", {
					head_sha: "a".repeat(40),
					run_attempt: 2,
					run_started_at: "2026-10-09T03:00:00Z",
					updated_at: "2026-10-09T03:10:00Z",
				}),
			),
			["b".repeat(40)]: pages(run("replaced", { head_sha: "b".repeat(40) })),
		};
		const { gh } = github(pull({ commits, timelineItems }), { shas });
		expect(ciRows(gh)).toEqual([
			"| 2026-09-30 22:50 | 0.00 | CI before opening | aaaaaaaa, success, 10.0 min |",
			"| 2026-10-01 01:00 | 2.17 | CI replaced | bbbbbbbb, success, 10.0 min |",
			"| 2026-10-09 03:00 | 196.17 | CI rerun after closing | aaaaaaaa, success, 10.0 min, attempt 2 |",
		]);
	});

	it("keeps a merge-group run only when its whole branch name is this pull request's queue branch on its base", () => {
		const sha = "f".repeat(40);
		const names = [
			`gh-readonly-queue/release.1/pr-1-${sha}`,
			`gh-readonly-queue/releasex1/pr-1-${sha}`,
			`gh-readonly-queue/release/pr-1-old/pr-7-${sha}`,
			`gh-readonly-queue/release.1/pr-1-${sha}0`,
			`x/gh-readonly-queue/release.1/pr-1-${sha}`,
			`gh-readonly-queue/release.1/pr-1-${"F".repeat(40)}`,
			`gh-readonly-queue/release.1/pr-11-${sha}`,
		];
		const group = [
			{
				total_count: names.length,
				workflow_runs: names.map((head_branch, i) => run(`q${i}`, { event: "merge_group", head_branch })),
			},
		];
		const { gh } = github(pull({ baseRefName: "release.1" }), { group });
		expect(ciRows(gh).map((row) => row.split("|")[3].trim())).toEqual(["CI q0"]);
	});

	it("shows a run's attempt only when it is above 1", () => {
		const commits = page([commit("a".repeat(40), start)]);
		const runs = [1, 2].map((attempt) => run(`try ${attempt}`, { head_sha: "a".repeat(40), run_attempt: attempt }));
		const { gh } = github(pull({ commits }), {
			shas: { ["a".repeat(40)]: [{ total_count: 2, workflow_runs: runs }] },
		});
		expect(ciRows(gh).map((row) => row.split("|")[4].trim())).toEqual([
			"aaaaaaaa, success, 10.0 min",
			"aaaaaaaa, success, 10.0 min, attempt 2",
		]);
	});

	it("searches an open pull request's merge-group runs up to now", () => {
		const { gh, queue } = github(pull(), {});
		Timeline.fetch({ number: 1, repo: "o/r", gh, now: "2026-10-09T00:00:00Z" });
		expect(queue()).toContain("created=2026-10-01T00:00:00.000Z..2026-10-09T00:00:00Z");
	});

	it.each([
		{ search: "commit", total: 2, throws: false },
		{ search: "commit", total: 3, throws: true },
		{ search: "group", total: 2, throws: false },
		{ search: "group", total: 3, throws: true },
	])(
		"checks the $search search's total_count of $total against the two runs its pages returned",
		({ search, total, throws }) => {
			const pages = [
				{ total_count: total, workflow_runs: [ci("a")] },
				{ total_count: total, workflow_runs: [ci("b")] },
			];
			const answers = search === "group" ? { group: pages } : { shas: { ["a".repeat(40)]: pages } };
			const commits = page([commit("a".repeat(40), start)]);
			const { gh } = github(pull({ commits, timelineItems: merged }), answers);
			const fetch = () => Timeline.fetch({ number: 1, repo: "o/r", gh });
			if (throws)
				expect(fetch).toThrow(
					`GitHub found ${total} workflow runs and returned 2; the timeline would be incomplete`,
				);
			else expect(fetch).not.toThrow();
		},
	);
});

describe("overall span", () => {
	it("ends an unmerged pull request's total at the end of its last CI run", () => {
		const runs = [
			{
				name: "check",
				event: "push",
				head_sha: "1".repeat(40),
				status: "completed",
				conclusion: "success",
				run_started_at: "2026-10-01T01:00:00.000Z",
				updated_at: "2026-10-01T03:00:00.000Z",
			},
		];
		const timeline = Timeline.from({ pull: pull(), runs });
		expect(rows(timeline).at(-1)).toBe("| total | 3.00 h |");
	});

	it("ends a merged pull request's total at its merge and keeps a later comment in the table", () => {
		const timelineItems = page([
			{ __typename: "MergedEvent", createdAt: "2026-10-01T02:00:00.000Z", commit: { oid: "e".repeat(40) } },
			{ __typename: "IssueComment", createdAt: "2026-10-11T02:00:00.000Z", body: "Thanks", author: { login: "b" } },
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain("| 2026-10-11 02:00 | 242.00 | comment | by b |");
		expect(rows(timeline).at(-1)).toBe("| total | 2.00 h |");
	});
});

describe("force-pushes", () => {
	it("prints one row per force-push with the commit before and after, or unknown where GitHub has none", () => {
		const timelineItems = page([
			{
				__typename: "HeadRefForcePushedEvent",
				createdAt: "2026-10-01T01:00:00.000Z",
				beforeCommit: { oid: "a".repeat(40) },
				afterCommit: { oid: "b".repeat(40) },
			},
			{
				__typename: "HeadRefForcePushedEvent",
				createdAt: "2026-10-01T02:00:00.000Z",
				beforeCommit: null,
				afterCommit: null,
			},
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline).filter((row) => row.includes("force-pushed"))).toEqual([
			"| 2026-10-01 01:00 | 1.00 | force-pushed | aaaaaaaa to bbbbbbbb |",
			"| 2026-10-01 02:00 | 2.00 | force-pushed | unknown to unknown |",
		]);
	});
});

describe("queued runs", () => {
	it("places a queued run, which has not started, at its creation and keeps its status", () => {
		const runs = [
			{
				name: "check",
				event: "push",
				head_sha: "1".repeat(40),
				status: "queued",
				conclusion: null,
				created_at: "2026-10-01T01:00:00.000Z",
				run_started_at: null,
				updated_at: "2026-10-01T01:00:00.000Z",
			},
		];
		const timeline = Timeline.from({ pull: pull(), runs });
		expect(rows(timeline)).toContain("| 2026-10-01 01:00 | 1.00 | CI check | 11111111, queued, 0.0 min |");
	});
});

describe("printed text", () => {
	it("sanitises the event column as well, so a workflow name cannot break the table or reach the terminal raw", () => {
		const name = `build\n${String.fromCharCode(0x1b)}[2J|x`;
		const runs = [
			{
				name,
				event: "push",
				head_sha: "1".repeat(40),
				status: "completed",
				conclusion: "success",
				run_started_at: "2026-10-01T01:00:00.000Z",
				updated_at: "2026-10-01T01:10:00.000Z",
			},
		];
		const timeline = Timeline.from({ pull: pull(), runs });
		expect(rows(timeline)).toContain(
			"| 2026-10-01 01:00 | 1.00 | CI build\\u000a\\u001b\\[2J\\|x | 11111111, success, 10.0 min |",
		);
	});

	it("writes C0 and C1 control characters, ESC and DEL among them, as visible escapes and keeps the characters beside each range", () => {
		const char = (code) => String.fromCharCode(code);
		const text = [0x1b, 0x1f, 0x20, 0x7e, 0x7f, 0x80, 0x9b, 0x9f, 0xa0].map(char).join("");
		const body = `Timing: x${text}y 5 min`;
		const timelineItems = page([
			{ __typename: "IssueComment", createdAt: "2026-10-01T01:00:00.000Z", body, author: { login: "b" } },
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		const expected = `x\\u001b\\u001f ~\\u007f\\u0080\\u009b\\u009f${char(0xa0)}y 5 min`;
		expect(rows(timeline)).toContain(`| 2026-10-01 01:00 | 1.00 | Timing | ${expected} |`);
	});
});

describe("visible text", () => {
	it("writes a bidi override, a line separator and an ESC in a workflow name as visible escapes", () => {
		const char = (code) => String.fromCharCode(code);
		const runs = [
			{
				name: `a${char(0x202e)}b${char(0x2028)}c${char(0x1b)}d`,
				event: "push",
				head_sha: "1".repeat(40),
				status: "completed",
				conclusion: "success",
				run_started_at: "2026-10-01T01:00:00.000Z",
				updated_at: "2026-10-01T01:10:00.000Z",
			},
		];
		const timeline = Timeline.from({ pull: pull(), runs });
		expect(rows(timeline)).toContain(
			"| 2026-10-01 01:00 | 1.00 | CI a\\u202eb\\u2028c\\u001bd | 11111111, success, 10.0 min |",
		);
	});
});

describe("Markdown text", () => {
	it("escapes a cell as Markdown text, so a commenter cannot plant a live link in the table", () => {
		const body = "Timing: \\[approved\\]\\(https://evil.example\\)";
		const timelineItems = page([
			{ __typename: "IssueComment", createdAt: "2026-10-01T01:00:00.000Z", body, author: { login: "b" } },
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain("| 2026-10-01 01:00 | 1.00 | Timing | \\[approved]\\(https://evil.example) |");
	});
});

describe("parseTiming", () => {
	it.each([
		["gate 2 × 14 min", { kind: "gate", count: 2, minutes: 28 }],
		["round 1 × 6 min, $6.40", { kind: "round", count: 1, minutes: 6, cost: 6.4 }],
		["own-build round 1 × 18 min, $2.43", { kind: "own-build round", count: 1, minutes: 18, cost: 2.43 }],
		["host round 2 × 11 min, $8.00", { kind: "host round", count: 2, minutes: 22, cost: 8 }],
		["codex 3 × 6 min", { kind: "codex", count: 3, minutes: 18 }],
		["review of record 1 × 55 min", { kind: "review of record", count: 1, minutes: 55 }],
		["mutants 2 × 15.5 min", { kind: "mutants", count: 2, minutes: 31 }],
		[
			"wait 1 × 10 min for the coordinator's answer",
			{ kind: "wait", count: 1, minutes: 10, cause: "the coordinator's answer" },
		],
		[
			"other 1 × 15 min (CI diagnosis and fix)",
			{ kind: "other", count: 1, minutes: 15, note: "CI diagnosis and fix" },
		],
	])("reads the kind in %s, with no key it does not use", (text, item) => {
		expect(parseTiming(`Timing: ${text}`)).toStrictEqual([{ text, ...item }]);
	});

	it("covers every kind the grammar names, in the order the summary prints them", () => {
		expect(KINDS).toEqual([
			"gate",
			"round",
			"own-build round",
			"host round",
			"codex",
			"review of record",
			"mutants",
			"wait",
			"other",
		]);
	});

	it("separates items at each semicolon and drops a trailing full stop and empty items", () => {
		expect(parseTiming("Timing: gate 1 × 2 min;; round 1 × 3 min.")).toEqual([
			{ text: "gate 1 × 2 min", kind: "gate", count: 1, minutes: 2 },
			{ text: "round 1 × 3 min", kind: "round", count: 1, minutes: 3 },
		]);
	});

	it("reads a count of one when the item names none, and multiplies the minutes by the count", () => {
		expect(parseTiming("Timing: gate 5 min; gate 12 × 3 min")).toEqual([
			{ text: "gate 5 min", kind: "gate", count: 1, minutes: 5 },
			{ text: "gate 12 × 3 min", kind: "gate", count: 12, minutes: 36 },
		]);
	});

	it("keeps a cost as the item's own total, never multiplied by its count", () => {
		expect(parseTiming("Timing: round 2 × 5 min, $3.50")).toEqual([
			{ text: "round 2 × 5 min, $3.50", kind: "round", count: 2, minutes: 10, cost: 3.5 },
		]);
	});

	it("reads a cause that names a number without a duration or a cost", () => {
		expect(parseTiming("Timing: wait 1 × 5 min for issue 400")).toStrictEqual([
			{ text: "wait 1 × 5 min for issue 400", kind: "wait", count: 1, minutes: 5, cause: "issue 400" },
		]);
	});

	it("keeps a note in brackets after the minutes, the cost or the cause", () => {
		expect(
			parseTiming("Timing: gate 4 × 13 min (one failed); round 1 × 6 min, $1 (cold); wait 1 × 3 min for CI (twice)"),
		).toEqual([
			{ text: "gate 4 × 13 min (one failed)", kind: "gate", count: 4, minutes: 52, note: "one failed" },
			{ text: "round 1 × 6 min, $1 (cold)", kind: "round", count: 1, minutes: 6, cost: 1, note: "cold" },
			{ text: "wait 1 × 3 min for CI (twice)", kind: "wait", count: 1, minutes: 3, cause: "CI", note: "twice" },
		]);
	});

	it.each([
		["a kind the grammar does not name", "review 2 min"],
		["a kind with a capital letter", "Gate 2 min"],
		["a count of zero", "gate 0 × 5 min"],
		["a letter x for the multiplication sign", "gate 2 x 3 min"],
		["a count with no minutes", "gate 2 ×"],
		["minutes with no unit", "gate 5"],
		["about before the minutes", "gate 4 × about 13 min"],
		["minutes with three decimal places", "gate 1.005 min"],
		["a cost with three decimal places", "gate 1 min, $1.005"],
		["a waited item with three decimal places", "waited 1.005 min for CI"],
		["a range of minutes", "gate 3 × 8 to 40 min"],
		["a list of minutes", "rounds 42592039166, 42595639774 and 42608746510 at 12, 12 and 10 min"],
		["two minutes in one item", "mutation runs 25 min and 6 min"],
		["about before the cost", "host round 2 × 11 min, about $4.00 each"],
		["words after the cost", "round 1 × 6 min, $6 each"],
		["a cause on a kind that is not a wait", "gate 5 min for CI"],
		["a wait with no cause", "wait 3 min"],
		["a wait whose cause hides a second duration", "wait 1 × 10 min for CI and 20 min for the coordinator"],
		["a wait whose cause hides a cost", "wait 10 min for CI, $6.40"],
		["a waited item whose cause hides a second duration", "waited 10 min for CI and 5 min for a ruling"],
		["an other with no note", "other 3 min"],
		["a wait whose cause is blank", "wait 1 × 10 min for   (note)"],
		["an other whose note is blank", "other 5 min ( )"],
		["a note with a bracket inside it", "gate 1 × 2 min (a (b))"],
		["words before the kind", "then gate 5 min"],
		["free text", "lunch | break"],
	])("leaves %s unparsed: %s", (_rule, text) => {
		expect(parseTiming(`Timing: ${text}`)).toEqual([{ text }]);
	});

	it.each([
		["two decimal places in minutes", "gate 1.25 min", { kind: "gate", count: 1, minutes: 1.25 }],
		["two decimal places in the cost", "gate 1 min, $1.25", { kind: "gate", count: 1, minutes: 1, cost: 1.25 }],
		["six whole digits of minutes", "gate 999999.99 min", { kind: "gate", count: 1, minutes: 999999.99 }],
		["six whole digits of cost", "gate 1 min, $999999.99", { kind: "gate", count: 1, minutes: 1, cost: 999999.99 }],
		["a three-digit count", "gate 999 × 1 min", { kind: "gate", count: 999, minutes: 999 }],
	])("reads %s, at the bound", (_bound, text, item) => {
		expect(parseTiming(`Timing: ${text}`)).toStrictEqual([{ text, ...item }]);
	});

	it.each([
		["seven whole digits of minutes", "gate 1000000 min"],
		["seven whole digits of cost", "gate 1 min, $1000000"],
		["a four-digit count", "gate 1000 × 1 min"],
	])("leaves %s unparsed, one past the bound", (_bound, text) => {
		expect(parseTiming(`Timing: ${text}`)).toEqual([{ text }]);
	});

	it("reads the shapes older reports used as the kind they mean", () => {
		expect(
			parseTiming(
				"Timing: waited 40.5 min for a ruling; Codex review 9 min; rounds 2 × 10 min; own-build rounds 4 × 12 min; host rounds 2 × 5 min; gates 3 × 14 min; Actions rounds 2 × 10 min; reviews of record 2 × 15 min; Actions round 7 min; Melian round 5 min; Melian rounds 2 × 4 min; Codex reviews 2 × 6 min",
			),
		).toEqual([
			{ text: "waited 40.5 min for a ruling", kind: "wait", count: 1, minutes: 40.5, cause: "a ruling" },
			{ text: "Codex review 9 min", kind: "codex", count: 1, minutes: 9 },
			{ text: "rounds 2 × 10 min", kind: "round", count: 2, minutes: 20 },
			{ text: "own-build rounds 4 × 12 min", kind: "own-build round", count: 4, minutes: 48 },
			{ text: "host rounds 2 × 5 min", kind: "host round", count: 2, minutes: 10 },
			{ text: "gates 3 × 14 min", kind: "gate", count: 3, minutes: 42 },
			{ text: "Actions rounds 2 × 10 min", kind: "round", count: 2, minutes: 20 },
			{ text: "reviews of record 2 × 15 min", kind: "review of record", count: 2, minutes: 30 },
			{ text: "Actions round 7 min", kind: "round", count: 1, minutes: 7 },
			{ text: "Melian round 5 min", kind: "round", count: 1, minutes: 5 },
			{ text: "Melian rounds 2 × 4 min", kind: "round", count: 2, minutes: 8 },
			{ text: "Codex reviews 2 × 6 min", kind: "codex", count: 2, minutes: 12 },
		]);
	});

	it("parses every unparsed line the rollup quoted in its nearest legal form, and leaves the line itself unparsed", () => {
		const rollup = JSON.parse(
			readFileSync(new URL("./fixtures/pr-timeline/rollup-unparsed.json", import.meta.url), "utf8"),
		);
		expect(rollup.length).toBeGreaterThan(0);
		for (const { line, legal } of rollup) {
			expect(parseTiming(`Timing: ${line}`), line).toEqual([{ text: line }]);
			if (legal !== null) {
				const parsed = parseTiming(`Timing: ${legal}`);
				expect(parsed, legal).toHaveLength(1);
				expect(parsed[0].kind, legal).toBeDefined();
			}
		}
	});

	it("reads AGENTS.md's own example Timing line as legal, every item parsed", () => {
		const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
		const example = /`(Timing: [^`]+)`/.exec(agents.slice(agents.indexOf("### Work from issues")));
		expect(example).not.toBeNull();
		const items = parseTiming(example[1]);
		expect(items.length).toBeGreaterThan(3);
		expect(items.filter((item) => item.kind === undefined)).toEqual([]);
	});

	it("reads Timing only from paragraph text, never from an indented or fenced code block", () => {
		const body = "Report.\n\n    Timing: gate 5 min\n\n```\nTiming: round 3 min\n```\n\nTiming: codex 2 min";
		expect(parseTiming(body)).toEqual([{ text: "codex 2 min", kind: "codex", count: 1, minutes: 2 }]);
	});

	it("keeps a Timing line that holds a line separator, as text, instead of dropping it", () => {
		const separator = String.fromCharCode(0x2028);
		expect(parseTiming(`Timing: gate${separator}x 5 min; codex 2 min`)).toEqual([
			{ text: `gate${separator}x 5 min` },
			{ text: "codex 2 min", kind: "codex", count: 1, minutes: 2 },
		]);
	});

	it("reads Timing only from the body's own paragraphs, never from a block quote or a list", () => {
		const body = "> Timing: gate 5 min\n\n- Timing: gate 3 min\n\nTiming: codex 2 min";
		expect(parseTiming(body)).toEqual([{ text: "codex 2 min", kind: "codex", count: 1, minutes: 2 }]);
	});

	it("reads Timing only at the start of a line", () => {
		expect(parseTiming("Intro Timing: gate 5 min\nTiming: codex 2 min")).toEqual([
			{ text: "codex 2 min", kind: "codex", count: 1, minutes: 2 },
		]);
	});

	it("reads no item from a body with no Timing line", () => {
		expect(parseTiming("Report.\nNothing timed.")).toEqual([]);
	});
});

describe("pull request 387", () => {
	const recording = fileURLToPath(new URL("./fixtures/pr-timeline/pr-387.json", import.meta.url));

	it("prints per-kind totals whose sum is the summary's total, and lists what it could not parse", () => {
		const result = run(["387"], recording);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const lines = result.stdout.split("\n");
		const value = (label) => lines.find((line) => line.startsWith(`| ${label} |`));
		const minutes = (line) => Number(/\| ([\d.]+) min/.exec(line)[1]);
		const kinds = lines.filter((line) => line.startsWith("| Timing: "));
		expect(kinds).toEqual([
			"| Timing: gate | 26 min |",
			"| Timing: own-build round | 18 min, $2.43 |",
			"| Timing: review of record | 55 min |",
			"| Timing: wait | 10 min |",
		]);
		expect(value("Timing reported")).toBe("| Timing reported | 109 min, $2.43 |");
		expect(kinds.reduce((sum, line) => sum + minutes(line), 0)).toBe(minutes(value("Timing reported")));
		const unparsed = lines.slice(lines.indexOf("| Timing not parsed | Comment time (UTC) |") + 2).filter(Boolean);
		expect(unparsed).toEqual([
			"| gate 4 × about 13 min (one failed on the workflow test) | 2026-11-13 08:06 |",
			"| Codex review 3 × about 6 min | 2026-11-13 08:06 |",
			"| mutation runs 25 min and 6 min | 2026-11-13 08:06 |",
			"| CI diagnosis and fix 15 min | 2026-11-13 08:27 |",
			"| mutant rerun 6 min | 2026-11-13 08:27 |",
			"| test and hand mutant 10 min | 2026-11-13 09:03 |",
		]);
	});
});
