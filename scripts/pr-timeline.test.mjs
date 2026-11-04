import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOUR, parseTiming, Timeline } from "./pr-timeline.mjs";

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

function run(args) {
	const dir = mkdtempSync(join(tmpdir(), "pr-timeline-"));
	try {
		writeFileSync(join(dir, "gh"), fakeGh);
		chmodSync(join(dir, "gh"), 0o755);
		const log = join(dir, "requests.log");
		writeFileSync(log, "");
		const result = spawnSync(process.execPath, [script, ...args.map((arg) => arg.replace("$DIR", dir))], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_FIXTURE: fixture, FAKE_GH_LOG: log },
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
	"| ready-wait | 2.00 |  |",
	"| build | 4.00 | 83 min, $6.40 |",
	"| review | 2.00 |  |",
	"| queue | 0.25 |  |",
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
			"| ready-wait | 1.50 |  |",
			"| build | — |  |",
			"| review | — |  |",
			"| queue | — |  |",
			"| CI | 0.0 min over 0 runs |  |",
			"| total | 1.75 |  |",
		]);
	});

	it("starts ready-wait at the first status: ready label, not the issue's opening or another label", () => {
		const issue = {
			number: 7,
			createdAt: "2026-10-01T00:00:00.000Z",
			timelineItems: page([
				{ __typename: "UnlabeledEvent", createdAt: "2026-10-01T00:15:00.000Z", label: { name: "status: ready" } },
				{ __typename: "LabeledEvent", createdAt: "2026-10-01T00:30:00.000Z", label: { name: "status: blocked" } },
				{ __typename: "LabeledEvent", createdAt: "2026-10-01T01:00:00.000Z", label: { name: "status: ready" } },
				{ __typename: "LabeledEvent", createdAt: "2026-10-01T01:30:00.000Z", label: { name: "status: ready" } },
				{
					__typename: "IssueComment",
					createdAt: "2026-10-01T02:00:00.000Z",
					body: "Claim: me",
					author: { login: "me" },
				},
			]),
		};
		const timeline = Timeline.from({ pull: pull({ closingIssuesReferences: page([issue]) }), runs: [] });
		expect(rows(timeline)).toContain("| ready-wait | 1.00 |  |");
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
		expect(rows(timeline).filter((row) => /^\| (ready-wait|build) /.test(row))).toEqual([
			"| ready-wait | 0.17 | 1 min |",
			"| build | 0.83 | 2 min |",
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
});

describe("stage bounds", () => {
	it("prints — for a stage whose end is known and whose start is not", () => {
		const timelineItems = page([{ __typename: "ReadyForReviewEvent", createdAt: "2026-10-01T01:00:00.000Z" }]);
		const timeline = Timeline.from({ pull: pull({ timelineItems }), runs: [] });
		expect(rows(timeline)).toContain("| review | — |  |");
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

	it("reads no item from a body with no Timing line", () => {
		expect(parseTiming("Report.\nNothing timed.")).toEqual([]);
	});
});
