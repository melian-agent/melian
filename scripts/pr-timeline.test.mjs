import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RoundComment } from "./round.mjs";
import { HOUR, parseTiming, Timeline } from "./timeline.mjs";

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
	"| CI | 29.0 min over 2 runs |",
	"| total | 8.27 h |",
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
				body: "Timing: review 3 min",
				author: null,
			},
			{ __typename: "IssueComment", createdAt: at, body: "Timing: round 2 min", author: { login: "b" } },
		]);
		const body = "Closes #2\n\nTiming: gate 5 min";
		const timeline = Timeline.from({ pull: pull({ body, timelineItems }), runs: [] });
		expect(rows(timeline).filter((row) => row.includes("Timing"))).toEqual([
			"| 2026-10-01 01:00 | 1.00 | Timing | round 2 min |",
			"| Timing reported | 2 min |",
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

	it("sums every Timing item's minutes and cost across comments into one line", () => {
		const comment = (hours, body) => ({
			__typename: "IssueComment",
			createdAt: new Date(start + hours * HOUR).toISOString(),
			body,
			author: { login: "b" },
		});
		const timelineItems = page([
			comment(1, "Timing: gate 2 × 14 min; round 6 min, $6.40"),
			comment(2, "Timing: waited 40.5 min for CI; lunch"),
			comment(3, "Timing: review 1 min, $0.10"),
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain("| Timing reported | 75.5 min, $6.50 |");
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
	it("reads multi-digit counts, decimal minutes and costs, and refuses trailing or leading words", () => {
		expect(
			parseTiming(
				"Timing: gate 12 × 3 min; round 1.25 min, $12.40; round 2 min, $6; waited 40.25 min for CI; gate 5 min extra; then waited 5 min for CI",
			),
		).toEqual([
			{ text: "gate 12 × 3 min", minutes: 36 },
			{ text: "round 1.25 min, $12.40", minutes: 1.25, cost: 12.4 },
			{ text: "round 2 min, $6", minutes: 2, cost: 6 },
			{ text: "waited 40.25 min for CI", minutes: 40.25 },
			{ text: "gate 5 min extra" },
			{ text: "then waited 5 min for CI" },
		]);
	});

	it("reads each item, keeps an unreadable one as text, and ignores other lines", () => {
		expect(
			parseTiming(
				"Intro Timing: no\n  Timing: gate 2 × 14 min; round 6 min, $6.40;; waited 40.5 min for a ruling; tea; gate 2 x 3 min.\nTiming: Codex review 9 min",
			),
		).toEqual([
			{ text: "gate 2 × 14 min", minutes: 28 },
			{ text: "round 6 min, $6.40", minutes: 6, cost: 6.4 },
			{ text: "waited 40.5 min for a ruling", minutes: 40.5 },
			{ text: "tea" },
			{ text: "gate 2 x 3 min", minutes: 3 },
			{ text: "Codex review 9 min", minutes: 9 },
		]);
	});

	it("reads Timing only from paragraph text, never from an indented or fenced code block", () => {
		const body = "Report.\n\n    Timing: gate 5 min\n\n```\nTiming: round 3 min\n```\n\nTiming: review 2 min";
		expect(parseTiming(body)).toEqual([{ text: "review 2 min", minutes: 2 }]);
	});

	it("keeps a Timing line that holds a line separator, as text, instead of dropping it", () => {
		const separator = String.fromCharCode(0x2028);
		expect(parseTiming(`Timing: gate${separator}x 5 min; review 2 min`)).toEqual([
			{ text: `gate${separator}x 5 min` },
			{ text: "review 2 min", minutes: 2 },
		]);
	});

	it("reads Timing only from the body's own paragraphs, never from a block quote or a list", () => {
		const body = "> Timing: quoted 5 min\n\n- Timing: listed 3 min\n\nTiming: review 2 min";
		expect(parseTiming(body)).toEqual([{ text: "review 2 min", minutes: 2 }]);
	});

	it("reads no item from a body with no Timing line", () => {
		expect(parseTiming("Report.\nNothing timed.")).toEqual([]);
	});
});

describe("rounds", () => {
	const base = "b".repeat(40);
	const head = "0123456789abcdef0123456789abcdef01234567";
	const mergeBase = "e".repeat(40);
	// A round comment as the melian round workflow posts it, from a public verdict that carries the round's spend.
	const roundBody = (spend) =>
		new RoundComment({
			verdict: {
				status: "passed",
				blocking: false,
				findings: { block: [], acknowledge: [] },
				notRun: [],
				...(spend === undefined ? {} : { spend }),
			},
			exitCode: "0",
			runUrl: "https://example.test/run",
			runId: "42",
			nonce: "0123456789abcdef0123456789abcdef",
			base,
			head,
			mergeBase,
			reviewed: { base: mergeBase, head },
			current: { base, head },
		}).body();
	const comment = (minutes, body, login = "melian-status-bot") => ({
		__typename: "IssueComment",
		createdAt: new Date(start + minutes * 60_000).toISOString(),
		body,
		author: { login },
	});

	it("reads a round's minutes and cost from the status bot's round comment, as an event and in the summary", () => {
		const timeline = Timeline.from({
			pull: pull({
				timelineItems: page([
					comment(10, roundBody({ seconds: 572, tokens: 5644300, cost: 4.44 })),
					comment(40, roundBody({ seconds: 60, tokens: 10, cost: 0.5 })),
				]),
			}),
			runs: [],
		});
		expect(rows(timeline).filter((row) => row.includes("| round |"))).toEqual([
			"| 2026-10-01 00:10 | 0.17 | round | 9.5 min, 5644300 tokens, $4.44 |",
			"| 2026-10-01 00:40 | 0.67 | round | 1.0 min, 10 tokens, $0.50 |",
		]);
		expect(rows(timeline)).toContain("| Rounds | 2 rounds, 10.5 min, $4.94 |");
		expect(rows(timeline)).toContain("| Timing reported | none |");
	});

	it("reads no round from another author's comment, a comment without the round's marker, or a spend line outside the fence", () => {
		const timeline = Timeline.from({
			pull: pull({
				timelineItems: page([
					comment(10, roundBody({ seconds: 572, tokens: 5644300, cost: 4.44 }), "someone"),
					comment(20, roundBody({ seconds: 572, tokens: 5644300, cost: 4.44 }).split("\n").slice(1).join("\n")),
					comment(30, "<!-- melian-round run:1 nonce:00 -->\nSpend: 572 s, 5644300 tokens, $4.44\n"),
					comment(40, roundBody()),
				]),
			}),
			runs: [],
		});
		expect(rows(timeline).filter((row) => row.includes("| round |"))).toEqual([]);
		expect(rows(timeline).some((row) => row.startsWith("| Rounds |"))).toBe(false);
	});

	it.each([
		["text before a part", "572 s, x12 tokens"],
		["text after a part", "572 s, 12 tokensx"],
		["a part it does not know", "572 s, 12 tokens, soon"],
		["seconds with a fraction, which the comment never writes", "572.5 s"],
		["a cost without its two decimals", "$4.4"],
	])("reads no round from a spend line with %s", (_name, spend) => {
		const body = `<!-- melian-round run:1 nonce:00 -->\nMelian round\n\n\`\`\`text\nVerdict: passed\nSpend: ${spend}\n\`\`\`\n`;
		const timeline = Timeline.from({ pull: pull({ timelineItems: page([comment(10, body)]) }), runs: [] });
		expect(rows(timeline).filter((row) => row.includes("| round |"))).toEqual([]);
	});

	it("reads no round when the line after the verdict only ends with a spend", () => {
		const body =
			"<!-- melian-round run:1 nonce:00 -->\nMelian round\n\n```text\nVerdict: passed\nNot Spend: 572 s\n```\n";
		const timeline = Timeline.from({ pull: pull({ timelineItems: page([comment(10, body)]) }), runs: [] });
		expect(rows(timeline).filter((row) => row.includes("| round |"))).toEqual([]);
	});

	it("reads a round that names its minutes and cost but no tokens", () => {
		const timeline = Timeline.from({
			pull: pull({ timelineItems: page([comment(10, roundBody({ seconds: 60, cost: 0.5 }))]) }),
			runs: [],
		});
		expect(rows(timeline).filter((row) => row.includes("| round |"))).toEqual([
			"| 2026-10-01 00:10 | 0.17 | round | 1.0 min, $0.50 |",
		]);
	});

	it("reads a round whose spend names only some of its numbers", () => {
		const timeline = Timeline.from({
			pull: pull({ timelineItems: page([comment(10, roundBody({ tokens: 12 }))]) }),
			runs: [],
		});
		expect(rows(timeline).filter((row) => row.includes("| round |"))).toEqual([
			"| 2026-10-01 00:10 | 0.17 | round | 12 tokens |",
		]);
		expect(rows(timeline)).toContain("| Rounds | 1 round, 0 min |");
	});
});
