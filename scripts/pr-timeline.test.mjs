import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
	"| 2026-10-01 00:00 | 0.00 | issue opened | #901 |",
	"| 2026-10-01 00:00 | 0.00 | labelled | #901 status: ready |",
	"|  |  | gap | 2.0 h |",
	"| 2026-10-01 02:00 | 2.00 | Claim | #901 by builder |",
	"| 2026-10-01 02:00 | 2.00 | labelled | #901 status: in progress |",
	"| 2026-10-01 02:00 | 2.00 | unlabelled | #901 status: ready |",
	"| 2026-10-01 03:00 | 3.00 | commit | aaaaaaaa |",
	"|  |  | gap | 1.0 h |",
	"| 2026-10-01 04:00 | 4.00 | commit | bbbbbbbb |",
	"| 2026-10-01 04:10 | 4.17 | pull request opened | #900 by builder |",
	"| 2026-10-01 04:10 | 4.17 | CI check | cccccccc, success, 15.0 min |",
	"| 2026-10-01 04:20 | 4.33 | merge commit | cccccccc |",
	"| 2026-10-01 05:25 | 5.42 | comment | by builder |",
	"| 2026-10-01 05:25 | 5.42 | Timing | gate 2 × 14 min |",
	"| 2026-10-01 05:25 | 5.42 | Timing | round 1 × 6 min, $6.40 |",
	"| 2026-10-01 05:25 | 5.42 | Timing | Codex review 9 min |",
	"| 2026-10-01 05:25 | 5.42 | Timing | waited 40 min for a ruling |",
	"| 2026-10-01 05:25 | 5.42 | Timing | lunch \\| break |",
	"| 2026-10-01 05:30 | 5.50 | review | approved by maintainer |",
	"| 2026-10-01 05:40 | 5.67 | Fix pass | #901 by builder |",
	"| 2026-10-01 06:00 | 6.00 | commit | dddddddd |",
	"|  |  | gap | 2.0 h |",
	"| 2026-10-01 08:00 | 8.00 | ready for review |  |",
	"| 2026-10-01 08:01 | 8.02 | queued |  |",
	"| 2026-10-01 08:01 | 8.03 | CI check | merge group, success, 14.0 min |",
	"| 2026-10-01 08:16 | 8.27 | merged | eeeeeeee |",
	"| 2026-10-01 08:16 | 8.27 | left the queue | merged |",
	"",
	"| Stage | Hours | Timing reported |",
	"| --- | --- | --- |",
	"| ready to claim | 2.00 |  |",
	"| claim to last commit | 4.00 | 83 min, $6.40 |",
	"| last commit to ready | 2.00 |  |",
	"| queued to merged | 0.25 |  |",
	"| CI | 29.0 min over 2 runs |  |",
	"| total | 8.27 |  |",
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

	it("prints the host's table for pull request 256, with the first cut's gaps, commits and totals", () => {
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
		expect(lines.slice(-9)).toEqual([
			"| Stage | Hours | Timing reported |",
			"| --- | --- | --- |",
			"| ready to claim | 18.22 |  |",
			"| claim to last commit | 191.70 |  |",
			"| last commit to ready | 2.47 |  |",
			"| queued to merged | 0.23 |  |",
			"| CI | 159.9 min over 14 runs |  |",
			"| total | 212.62 |  |",
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
			"| CI | 180.0 min over 1 runs |  |",
		]);
	});

	it("never lets a Timing item fill a gap", () => {
		const commits = page([commit("1".repeat(40), start), commit("2".repeat(40), start + 3 * HOUR)]);
		const body = "Timing: gate 5 min";
		const at = new Date(start + 2 * HOUR).toISOString();
		const timelineItems = page([
			{ __typename: "PullRequestReview", submittedAt: at, state: "COMMENTED", body, author: null },
		]);
		const timeline = Timeline.from({ pull: pull({ commits, timelineItems }), runs: [] });
		expect(rows(timeline).slice(2, 8)).toEqual([
			"| 2026-10-01 00:00 | 0.00 | pull request opened | #1 by a |",
			"| 2026-10-01 00:00 | 0.00 | commit | 11111111 |",
			"|  |  | gap | 2.0 h |",
			"| 2026-10-01 02:00 | 2.00 | review | commented by ghost |",
			"| 2026-10-01 02:00 | 2.00 | Timing | gate 5 min |",
			"| 2026-10-01 03:00 | 3.00 | commit | 22222222 |",
		]);
	});
});

describe("Timing rows", () => {
	it("reads a Timing line from the pull request's description, at its opening", () => {
		const timeline = Timeline.from({ pull: pull({ body: "Closes #2\n\nTiming: gate 5 min" }), runs: [] });
		expect(rows(timeline).slice(2, 4)).toEqual([
			"| 2026-10-01 00:00 | 0.00 | pull request opened | #1 by a |",
			"| 2026-10-01 00:00 | 0.00 | Timing | gate 5 min |",
		]);
	});
});

describe("stages", () => {
	it("falls back to the issue's opening when no status: ready label exists, and prints — for an unknown stage", () => {
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
			"| 2026-10-01 01:30 | 1.50 | Claim | #7 by me |",
			"| 2026-10-01 01:45 | 1.75 | Claim | #7 by late |",
		]);
		expect(rows(timeline).slice(-6)).toEqual([
			"| ready to claim | 1.50 |  |",
			"| claim to last commit | — |  |",
			"| last commit to ready | — |  |",
			"| queued to merged | — |  |",
			"| CI | 0.0 min over 0 runs |  |",
			"| total | 1.75 |  |",
		]);
	});

	it("starts ready to claim at the last status: ready label before the claim, not an unlabel or another label", () => {
		const at = (hours) => new Date(start + hours * HOUR).toISOString();
		const issue = {
			number: 7,
			createdAt: at(0),
			timelineItems: page([
				{ __typename: "LabeledEvent", createdAt: at(1), label: { name: "status: ready" } },
				{ __typename: "LabeledEvent", createdAt: at(1.5), label: { name: "status: ready" } },
				{ __typename: "UnlabeledEvent", createdAt: at(1.75), label: { name: "status: ready" } },
				{ __typename: "LabeledEvent", createdAt: at(1.8), label: { name: "status: blocked" } },
				{ __typename: "IssueComment", createdAt: at(2), body: "Claim: me", author: { login: "me" } },
			]),
		};
		const timeline = Timeline.from({ pull: pull({ closingIssuesReferences: page([issue]) }), runs: [] });
		expect(rows(timeline)).toContain("| ready to claim | 0.50 |  |");
	});

	it("measures a released and reclaimed issue from its last ready label to the claim that won", () => {
		const at = (hours) => new Date(start + hours * HOUR).toISOString();
		const issue = {
			number: 7,
			createdAt: at(0),
			timelineItems: page([
				{ __typename: "LabeledEvent", createdAt: at(0), label: { name: "status: ready" } },
				{ __typename: "IssueComment", createdAt: at(2), body: "Claim: first", author: { login: "a" } },
				{ __typename: "IssueComment", createdAt: at(4), body: "Released: stale", author: { login: "m" } },
				{ __typename: "LabeledEvent", createdAt: at(5), label: { name: "status: ready" } },
				{ __typename: "IssueComment", createdAt: at(5.5), body: "Claim: second", author: { login: "b" } },
				{ __typename: "IssueComment", createdAt: at(5.75), body: "Claim: late", author: { login: "c" } },
			]),
		};
		const commits = page([commit("1".repeat(40), start + 8 * HOUR)]);
		const timeline = Timeline.from({ pull: pull({ closingIssuesReferences: page([issue]), commits }), runs: [] });
		expect(rows(timeline).filter((row) => /^\| (ready to claim|claim to last commit) /.test(row))).toEqual([
			"| ready to claim | 0.50 |  |",
			"| claim to last commit | 2.50 |  |",
		]);
	});

	it("measures no claim when the issue was marked ready again after its last claim", () => {
		const at = (hours) => new Date(start + hours * HOUR).toISOString();
		const issue = {
			number: 7,
			createdAt: at(0),
			timelineItems: page([
				{ __typename: "LabeledEvent", createdAt: at(0), label: { name: "status: ready" } },
				{ __typename: "IssueComment", createdAt: at(2), body: "Claim: first", author: { login: "a" } },
				{ __typename: "LabeledEvent", createdAt: at(5), label: { name: "status: ready" } },
			]),
		};
		const timeline = Timeline.from({ pull: pull({ closingIssuesReferences: page([issue]) }), runs: [] });
		expect(rows(timeline)).toContain("| ready to claim | — |  |");
	});

	it("counts only the Timing items inside a stage, from its start up to but not including its end", () => {
		const commits = page([commit("1".repeat(40), start + HOUR)]);
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
				comment(0, "Timing: before 1 min"),
				comment(10, "Claim: b"),
				comment(10, "Timing: at start 2 min"),
				comment(60, "Timing: at end 4 min, $0.50"),
			]),
		};
		const timeline = Timeline.from({ pull: pull({ closingIssuesReferences: page([issue]), commits }), runs: [] });
		expect(rows(timeline).filter((row) => /^\| (ready to claim|claim to last commit) /.test(row))).toEqual([
			"| ready to claim | 0.17 | 1 min |",
			"| claim to last commit | 0.83 | 2 min |",
		]);
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
			return JSON.stringify(args.includes("event=merge_group") ? answers.group : answers.branch);
		};
		return { gh, asked };
	};
	const empty = [{ total_count: 0, workflow_runs: [] }];
	const merged = page([
		{ __typename: "MergedEvent", createdAt: "2026-10-02T00:00:00Z", commit: { oid: "e".repeat(40) } },
	]);

	it("searches merge-group runs only from a merged pull request's opening to its merge", () => {
		const { gh, asked } = github(pull({ timelineItems: merged }), { branch: empty, group: empty });
		Timeline.fetch({ number: 1, repo: "o/r", gh, now: "2026-10-09T00:00:00Z" });
		expect(asked[2]).toEqual([
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

	it("searches the branch's runs over the same window, so a reused branch name brings no other pull request's runs", () => {
		const { gh, asked } = github(pull({ timelineItems: merged }), { branch: empty, group: empty });
		Timeline.fetch({ number: 1, repo: "o/r", gh, now: "2026-10-09T00:00:00Z" });
		expect(asked[1]).toEqual([
			"api",
			"--paginate",
			"--slurp",
			"-X",
			"GET",
			"repos/o/r/actions/runs",
			"-f",
			"branch=b",
			"-f",
			"created=2026-10-01T00:00:00.000Z..2026-10-02T00:00:00Z",
			"-f",
			"per_page=100",
		]);
	});

	it("searches an open pull request's merge-group runs up to now", () => {
		const { gh, asked } = github(pull(), { branch: empty, group: empty });
		Timeline.fetch({ number: 1, repo: "o/r", gh, now: "2026-10-09T00:00:00Z" });
		expect(asked[2]).toContain("created=2026-10-01T00:00:00.000Z..2026-10-09T00:00:00Z");
	});

	it.each([
		{ search: "branch", total: 2, throws: false },
		{ search: "branch", total: 3, throws: true },
		{ search: "group", total: 2, throws: false },
		{ search: "group", total: 3, throws: true },
	])(
		"checks the $search search's total_count of $total against the two runs its pages returned",
		({ search, total, throws }) => {
			const pages = [
				{ total_count: total, workflow_runs: [ci("a")] },
				{ total_count: total, workflow_runs: [ci("b")] },
			];
			const answers = { branch: empty, group: empty, [search]: pages };
			const { gh } = github(pull({ timelineItems: merged }), answers);
			const fetch = () => Timeline.fetch({ number: 1, repo: "o/r", gh });
			if (throws)
				expect(fetch).toThrow(
					`GitHub found ${total} workflow runs and returned 2; the timeline would be incomplete`,
				);
			else expect(fetch).not.toThrow();
		},
	);
});

describe("stage bounds", () => {
	it("ends a merged pull request's total at its merge and keeps a later comment in the table", () => {
		const timelineItems = page([
			{ __typename: "MergedEvent", createdAt: "2026-10-01T02:00:00.000Z", commit: { oid: "e".repeat(40) } },
			{ __typename: "IssueComment", createdAt: "2026-10-11T02:00:00.000Z", body: "Thanks", author: { login: "b" } },
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain("| 2026-10-11 02:00 | 242.00 | comment | by b |");
		expect(rows(timeline).at(-1)).toBe("| total | 2.00 |  |");
	});

	it("prints — for a stage whose end is known and whose start is not", () => {
		const timelineItems = page([{ __typename: "ReadyForReviewEvent", createdAt: "2026-10-01T01:00:00.000Z" }]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain("| last commit to ready | — |  |");
	});
});

describe("printed text", () => {
	it("replaces C0 and C1 control characters, ESC and DEL among them, and keeps the characters beside each range", () => {
		const char = (code) => String.fromCharCode(code);
		const replaced = char(0xfffd);
		const text = [0x1b, 0x1f, 0x20, 0x7e, 0x7f, 0x80, 0x9b, 0x9f, 0xa0].map(char).join("");
		const body = `Timing: x${text}y 5 min`;
		const timelineItems = page([
			{ __typename: "IssueComment", createdAt: "2026-10-01T01:00:00.000Z", body, author: { login: "b" } },
		]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		const expected = `x${replaced}${replaced} ~${replaced}${replaced}${replaced}${replaced}${char(0xa0)}y 5 min`;
		expect(rows(timeline)).toContain(`| 2026-10-01 01:00 | 1.00 | Timing | ${expected} |`);
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

	it("reads no item from a body with no Timing line", () => {
		expect(parseTiming("Report.\nNothing timed.")).toEqual([]);
	});
});
