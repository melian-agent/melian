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

type Said = { event: "commented"; id: number; body: string; login: string; created_at: string };
type Labelled = { event: "labeled" | "unlabeled"; name: string; created_at: string };
type Other = { event: "assigned"; created_at: string };
type Item = Said | Labelled | Other;
type Permission = { permission: string; role_name?: string } | number;
type Scenario = {
	trigger: Said;
	pullRequest?: boolean;
	labels: string[];
	timeline: Item[];
	permissions: Record<string, Permission | string>;
	fail?: { add?: number; remove?: number };
};

class HttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`HTTP ${status}`);
		this.status = status;
	}
}

const issueParams = { owner: OWNER, repo: REPO, issue_number: ISSUE };
const commentUrl = (id: number) => `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}#issuecomment-${id}`;
const asComment = (said: Said) => ({
	id: said.id,
	body: said.body,
	user: { login: said.login },
	created_at: said.created_at,
	updated_at: said.created_at,
	html_url: commentUrl(said.id),
});
const asTimeline = (item: Item) =>
	item.event === "commented"
		? { event: "commented", ...asComment(item) }
		: item.event === "assigned"
			? { event: item.event, created_at: item.created_at }
			: { event: item.event, label: { name: item.name }, created_at: item.created_at };

// The script under test is the workflow's own text, run as github-script runs it. The fake holds one issue: its
// labels and its ordered timeline, from which it answers every read, and each write changes both, as GitHub would.
// Each method checks that the request names exactly what it should, so a script that asks the wrong question fails
// rather than gets an answer.
async function run(scenario: Scenario) {
	const writes: unknown[] = [];
	const asked: string[] = [];
	const fail = { ...scenario.fail };
	const exact = (actual: unknown, expected: unknown) => expect(actual).toStrictEqual(expected);
	const write = (event: "labeled" | "unlabeled", name: string) =>
		scenario.timeline.push({ event, name, created_at: "2026-11-05T12:00:00Z" });
	const github = {
		rest: {
			repos: {
				getCollaboratorPermissionLevel: async (params: { owner: string; repo: string; username: string }) => {
					exact(params, { owner: OWNER, repo: REPO, username: params.username });
					asked.push(params.username);
					const permission = scenario.permissions[params.username];
					if (typeof permission === "number") throw new HttpError(permission);
					if (permission === undefined) throw new Error(`unexpected permission lookup for ${params.username}`);
					return { data: typeof permission === "string" ? { permission } : permission };
				},
			},
			issues: {
				get: async (params: unknown) => {
					exact(params, issueParams);
					return { data: { labels: scenario.labels.map((name) => ({ name })) } };
				},
				listEventsForTimeline: async (params: unknown) => {
					exact(params, { ...issueParams, per_page: 100 });
					return { data: scenario.timeline.map(asTimeline) };
				},
				removeLabel: async (params: { name: string }) => {
					exact(params, { ...issueParams, name: params.name });
					if (fail.remove) throw new HttpError(fail.remove);
					writes.push(["remove", params.name]);
					scenario.labels = scenario.labels.filter((name) => name !== params.name);
					write("unlabeled", params.name);
				},
				addLabels: async (params: { labels: string[] }) => {
					exact(params, { ...issueParams, labels: params.labels });
					if (fail.add) throw new HttpError(fail.add);
					writes.push(["add", ...params.labels]);
					for (const name of params.labels) {
						scenario.labels.push(name);
						write("labeled", name);
					}
				},
			},
		},
		paginate: async (method: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) =>
			(await method(params)).data,
	};
	const context = {
		repo: { owner: OWNER, repo: REPO },
		payload: {
			comment: asComment(scenario.trigger),
			issue: { number: ISSUE, ...(scenario.pullRequest ? { pull_request: { url: "x" } } : {}) },
		},
	};
	const core = { info: () => {} };
	const body = new (Object.getPrototypeOf(async () => {}).constructor)("github", "context", "core", script);
	await body(github, context, core);
	return { writes, asked, labels: scenario.labels };
}

const at = (second: number) => `2026-11-05T10:00:${String(second).padStart(2, "0")}Z`;
const label = (name: string, second: number): Labelled => ({ event: "labeled", name, created_at: at(second) });
const unlabel = (name: string, second: number): Labelled => ({ event: "unlabeled", name, created_at: at(second) });
const say = (id: number, login: string, second: number, body = `Claim: ${login}`): Said => ({
	event: "commented",
	id,
	body,
	login,
	created_at: at(second),
});

const toInProgress = [
	["remove", READY],
	["add", IN_PROGRESS],
];
const toReady = [
	["remove", IN_PROGRESS],
	["add", READY],
];

// A ready issue whose last comment is the builder's claim, which triggered the run.
function claimScenario(overrides: Partial<Scenario> = {}): Scenario {
	const mine = say(20, "builder", 5);
	return {
		trigger: mine,
		labels: ["plan step", READY],
		timeline: [label(READY, 0), mine],
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
		expect(writes).toEqual(toInProgress);
		expect(asked).toEqual(["builder"]);
	});

	it.each(["admin", "write"])("accepts a claim from %s permission", async (permission) => {
		const { writes } = await run(claimScenario({ permissions: { builder: permission } }));
		expect(writes).toEqual(toInProgress);
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
		expect(scenario.labels).toEqual(["plan step", READY]);
	});

	it("ignores a claim when no event ever labelled the issue ready", async () => {
		const mine = say(20, "builder", 5);
		const { writes } = await run(claimScenario({ timeline: [label("plan step", 0), mine] }));
		expect(writes).toEqual([]);
	});

	it("ignores a second claim behind a writer's earlier one", async () => {
		const mine = say(20, "builder", 5);
		const timeline = [label(READY, 0), say(10, "other", 2), mine];
		const { writes } = await run(
			claimScenario({ timeline, permissions: { builder: "write", other: "admin" }, labels: [IN_PROGRESS] }),
		);
		expect(writes).toEqual([]);
	});

	it("is not blocked by a non-writer's earlier claim", async () => {
		const mine = say(20, "builder", 5);
		const timeline = [label(READY, 0), say(10, "stranger", 2), mine];
		const { writes } = await run(claimScenario({ timeline, permissions: { builder: "write", stranger: "read" } }));
		expect(writes).toEqual(toInProgress);
	});

	it("ignores claims before the last ready label", async () => {
		const mine = say(20, "builder", 50);
		const timeline = [
			label(READY, 0),
			{ event: "assigned", created_at: at(5) } as const,
			say(5, "other", 10),
			unlabel(READY, 20),
			label(READY, 40),
			label("plan step", 41),
			mine,
		];
		const { writes } = await run(claimScenario({ trigger: mine, timeline, permissions: { builder: "write" } }));
		expect(writes).toEqual(toInProgress);
	});

	it("orders a claim by the timeline, not its timestamp: one before the ready label loses at the same second", async () => {
		const mine = say(20, "builder", 9);
		const timeline = [say(10, "other", 4), label(READY, 4), mine];
		const { writes } = await run(
			claimScenario({ trigger: mine, timeline, permissions: { builder: "write", other: "write" } }),
		);
		expect(writes).toEqual(toInProgress);
	});

	it("ignores a claim posted before the issue was last marked ready", async () => {
		const mine = say(20, "builder", 5);
		const { writes } = await run(claimScenario({ timeline: [mine, label(READY, 10)] }));
		expect(writes).toEqual([]);
	});

	it("does not count a comment that only mentions a claim", async () => {
		const mine = say(20, "builder", 5);
		const timeline = [label(READY, 0), say(10, "other", 2, "I will post Claim: soon"), mine];
		const { writes } = await run(claimScenario({ timeline, permissions: { builder: "write", other: "write" } }));
		expect(writes).toEqual(toInProgress);
	});

	it.each([" Claim: builder", "claim: builder", "Claim builder"])("ignores a comment %j", async (body) => {
		const mine = say(20, "builder", 5, body);
		const { writes, asked } = await run(claimScenario({ trigger: mine, timeline: [label(READY, 0), mine] }));
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
	const release = say(30, "maintainer", 30, "Released: no push for 24 hours");
	const releaseScenario = (overrides: Partial<Scenario> = {}): Scenario => ({
		trigger: release,
		labels: ["plan step", IN_PROGRESS],
		timeline: [label(READY, 0), say(20, "builder", 5), label(IN_PROGRESS, 6), unlabel(READY, 6), release],
		permissions: { maintainer: "admin", builder: "write" },
		...overrides,
	});

	it("swaps in progress back to ready on a writer's release", async () => {
		const { writes } = await run(releaseScenario());
		expect(writes).toEqual(toReady);
	});

	it("ignores a release from a non-writer", async () => {
		const { writes } = await run(releaseScenario({ permissions: { maintainer: "read", builder: "write" } }));
		expect(writes).toEqual([]);
	});
});
