import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { uses?: string; run?: string; with?: { script?: string } };
const workflow = parse(readFileSync(new URL("../../../.github/workflows/claim.yml", import.meta.url), "utf8")) as {
	on: unknown;
	permissions: unknown;
	concurrency: unknown;
	jobs: Record<
		string,
		{ if: string; "runs-on": string; "timeout-minutes": number; permissions?: unknown; steps: Step[] }
	>;
};
const job = workflow.jobs["swap-labels"]!;
const script = job.steps[0]!.with!.script!;

const READY = "status: ready";
const IN_PROGRESS = "status: in progress";
const OWNER = "melian-agent";
const REPO = "melian";
const ISSUE = 7;

type Comment = { id: number; body: string; login: string; created_at: string; updated_at?: string };
type Event = { event: string; label?: { name: string }; created_at: string };
type Scenario = {
	comment: Comment;
	pullRequest?: boolean;
	labels: string[];
	events: Event[];
	comments: Comment[];
	permissions: Record<string, string | number>;
};

class HttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`HTTP ${status}`);
		this.status = status;
	}
}

const issueParams = { owner: OWNER, repo: REPO, issue_number: ISSUE };

// The script under test is the workflow's own text, run as github-script runs it. Each fake method checks that the
// request names exactly what it should, so a script that asks the wrong question fails rather than gets an answer.
async function run(scenario: Scenario) {
	const writes: unknown[] = [];
	const asked: string[] = [];
	const exact = (actual: unknown, expected: unknown) => expect(actual).toStrictEqual(expected);
	const toApi = (c: Comment) => ({
		id: c.id,
		body: c.body,
		user: { login: c.login },
		created_at: c.created_at,
		updated_at: c.updated_at ?? c.created_at,
		html_url: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}#issuecomment-${c.id}`,
	});
	const github = {
		rest: {
			repos: {
				getCollaboratorPermissionLevel: async (params: { owner: string; repo: string; username: string }) => {
					exact(params, { owner: OWNER, repo: REPO, username: params.username });
					asked.push(params.username);
					const permission = scenario.permissions[params.username];
					if (typeof permission === "number") throw new HttpError(permission);
					if (permission === undefined) throw new Error(`unexpected permission lookup for ${params.username}`);
					return { data: { permission } };
				},
			},
			issues: {
				get: async (params: unknown) => {
					exact(params, issueParams);
					return { data: { labels: scenario.labels.map((name) => ({ name })) } };
				},
				listEvents: async (params: unknown) => {
					exact(params, { ...issueParams, per_page: 100 });
					return { data: scenario.events };
				},
				listComments: async (params: { since: string }) => {
					exact(params, { ...issueParams, since: params.since, per_page: 100 });
					const since = Date.parse(params.since);
					return {
						data: scenario.comments.filter((c) => Date.parse(c.updated_at ?? c.created_at) >= since).map(toApi),
						since: params.since,
					};
				},
				removeLabel: async (params: unknown) => {
					writes.push(["remove", params]);
				},
				addLabels: async (params: unknown) => {
					writes.push(["add", params]);
				},
			},
		},
		paginate: async (method: (params: unknown) => Promise<{ data: unknown[]; since?: string }>, params: unknown) => {
			const { data, since } = await method(params);
			if (since !== undefined) asked.push(`since ${since}`);
			return data;
		},
	};
	const context = {
		repo: { owner: OWNER, repo: REPO },
		payload: {
			comment: toApi(scenario.comment),
			issue: { number: ISSUE, ...(scenario.pullRequest ? { pull_request: { url: "x" } } : {}) },
		},
	};
	const core = { info: () => {} };
	const body = new (Object.getPrototypeOf(async () => {}).constructor)("github", "context", "core", script);
	await body(github, context, core);
	return { writes, asked };
}

const swapped = (from: string, to: string) => [
	["remove", { ...issueParams, name: from }],
	["add", { ...issueParams, labels: [to] }],
];

const readied = (at: string): Event => ({ event: "labeled", label: { name: READY }, created_at: at });
const claim = (id: number, login: string, at: string, body = `Claim: ${login}`): Comment => ({
	id,
	body,
	login,
	created_at: at,
});

function claimScenario(overrides: Partial<Scenario> = {}): Scenario {
	const mine = claim(20, "builder", "2026-11-05T10:00:05Z");
	return {
		comment: mine,
		labels: ["plan step", READY],
		events: [readied("2026-11-05T10:00:00Z")],
		comments: [mine],
		permissions: { builder: "write" },
		...overrides,
	};
}

describe("claim workflow policy", () => {
	it("runs on new issue comments that start a claim or a release, with issues: write alone", () => {
		expect(workflow.on).toEqual({ issue_comment: { types: ["created"] } });
		expect(workflow.permissions).toEqual({ issues: "write" });
		expect(workflow.concurrency).toEqual({
			group: `claim-\${{ github.event.issue.number }}`,
			"cancel-in-progress": false,
		});
		expect(Object.keys(workflow.jobs)).toEqual(["swap-labels"]);
		expect(job.if).toBe(
			`\${{ !github.event.issue.pull_request && (startsWith(github.event.comment.body, 'Claim:') || startsWith(github.event.comment.body, 'Released:')) }}`,
		);
		expect(job.permissions).toBeUndefined();
		expect(job["timeout-minutes"]).toBe(5);
	});

	it("runs no repository code: one pinned github-script step, and no expression inside the script", () => {
		expect(job.steps).toHaveLength(1);
		expect(Object.keys(job.steps[0]!)).toEqual(["uses", "with"]);
		expect(job.steps[0]!.uses).toBe("actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd");
		expect(Object.keys(job.steps[0]!.with!)).toEqual(["script"]);
		expect(script).not.toContain(`\${{`);
	});
});

describe("claim workflow script", () => {
	it("swaps ready for in progress on a writer's first claim", async () => {
		const { writes, asked } = await run(claimScenario());
		expect(writes).toEqual(swapped(READY, IN_PROGRESS));
		expect(asked).toEqual(["builder", "since 2026-11-05T10:00:00Z"]);
	});

	it.each(["admin", "write"])("accepts a claim from %s permission", async (permission) => {
		const { writes } = await run(claimScenario({ permissions: { builder: permission } }));
		expect(writes).toEqual(swapped(READY, IN_PROGRESS));
	});

	it.each(["read", "triage", "none"])("ignores a claim from %s permission", async (permission) => {
		const { writes, asked } = await run(claimScenario({ permissions: { builder: permission } }));
		expect(writes).toEqual([]);
		expect(asked).toEqual(["builder"]);
	});

	it("ignores a claim from someone the permission endpoint does not know", async () => {
		const { writes } = await run(claimScenario({ permissions: { builder: 404 } }));
		expect(writes).toEqual([]);
	});

	it("fails without writing when the permission lookup errs", async () => {
		const scenario = claimScenario({ permissions: { builder: 500 } });
		await expect(run(scenario)).rejects.toThrow("HTTP 500");
	});

	it("ignores a claim on an issue that is not ready", async () => {
		const { writes } = await run(claimScenario({ labels: ["plan step", IN_PROGRESS] }));
		expect(writes).toEqual([]);
	});

	it("ignores a claim when no event ever labelled the issue ready", async () => {
		const events = [{ event: "labeled", label: { name: "plan step" }, created_at: "2026-11-05T10:00:00Z" }];
		const { writes } = await run(claimScenario({ events }));
		expect(writes).toEqual([]);
	});

	it("ignores a second claim behind a writer's earlier one", async () => {
		const first = claim(10, "other", "2026-11-05T10:00:02Z");
		const mine = claim(20, "builder", "2026-11-05T10:00:05Z");
		const { writes } = await run(
			claimScenario({ comments: [mine, first], permissions: { builder: "write", other: "admin" } }),
		);
		expect(writes).toEqual([]);
	});

	it("is not blocked by a non-writer's earlier claim", async () => {
		const first = claim(10, "stranger", "2026-11-05T10:00:02Z");
		const mine = claim(20, "builder", "2026-11-05T10:00:05Z");
		const { writes } = await run(
			claimScenario({ comments: [first, mine], permissions: { builder: "write", stranger: "read" } }),
		);
		expect(writes).toEqual(swapped(READY, IN_PROGRESS));
	});

	it("ignores comments before the last ready label, and counts one at the same second", async () => {
		const old = claim(5, "other", "2026-11-05T09:00:00Z", "Claim: other");
		const edgeOld = { ...claim(8, "other", "2026-11-05T09:59:59Z"), updated_at: "2026-11-05T10:00:00Z" };
		const mine = claim(20, "builder", "2026-11-05T10:00:00Z");
		const events = [
			readied("2026-11-05T08:00:00Z"),
			{ event: "assigned", created_at: "2026-11-05T08:30:00Z" },
			{ event: "unlabeled", label: { name: READY }, created_at: "2026-11-05T09:30:00Z" },
			readied("2026-11-05T10:00:00Z"),
			{ event: "labeled", label: { name: "plan step" }, created_at: "2026-11-05T10:00:01Z" },
		];
		const { writes } = await run(
			claimScenario({
				comment: mine,
				events,
				comments: [old, edgeOld, mine],
				permissions: { builder: "write", other: "write" },
			}),
		);
		expect(writes).toEqual(swapped(READY, IN_PROGRESS));
	});

	it("ignores a claim posted before the issue was last marked ready", async () => {
		const { writes } = await run(claimScenario({ events: [readied("2026-11-05T10:00:10Z")] }));
		expect(writes).toEqual([]);
	});

	it("loses to an earlier writer's claim at the ready label's own second", async () => {
		const first = claim(10, "other", "2026-11-05T10:00:00Z");
		const mine = claim(20, "builder", "2026-11-05T10:00:05Z");
		const { writes } = await run(
			claimScenario({ comments: [first, mine], permissions: { builder: "write", other: "write" } }),
		);
		expect(writes).toEqual([]);
	});

	it("does not count a comment that only mentions a claim", async () => {
		const first = claim(10, "other", "2026-11-05T10:00:02Z", "I will post Claim: soon");
		const mine = claim(20, "builder", "2026-11-05T10:00:05Z");
		const { writes } = await run(
			claimScenario({ comments: [first, mine], permissions: { builder: "write", other: "write" } }),
		);
		expect(writes).toEqual(swapped(READY, IN_PROGRESS));
	});

	it.each([" Claim: builder", "claim: builder", "Claim builder"])("ignores a comment %j", async (body) => {
		const mine = claim(20, "builder", "2026-11-05T10:00:05Z", body);
		const { writes, asked } = await run(claimScenario({ comment: mine, comments: [mine] }));
		expect(writes).toEqual([]);
		expect(asked).toEqual([]);
	});

	it("ignores a comment on a pull request", async () => {
		const { writes, asked } = await run(claimScenario({ pullRequest: true }));
		expect(writes).toEqual([]);
		expect(asked).toEqual([]);
	});
});

describe("release in the claim workflow script", () => {
	const release = claim(30, "maintainer", "2026-11-06T10:00:00Z", "Released: no push for 24 hours");
	const releaseScenario = (overrides: Partial<Scenario> = {}): Scenario => ({
		comment: release,
		labels: ["plan step", IN_PROGRESS],
		events: [],
		comments: [],
		permissions: { maintainer: "admin" },
		...overrides,
	});

	it("swaps in progress back to ready on a writer's release", async () => {
		const { writes, asked } = await run(releaseScenario());
		expect(writes).toEqual(swapped(IN_PROGRESS, READY));
		expect(asked).toEqual(["maintainer"]);
	});

	it("ignores a release from a non-writer", async () => {
		const { writes } = await run(releaseScenario({ permissions: { maintainer: "read" } }));
		expect(writes).toEqual([]);
	});

	it("ignores a release on an issue that is not in progress", async () => {
		const { writes } = await run(releaseScenario({ labels: ["plan step", READY] }));
		expect(writes).toEqual([]);
	});
});
