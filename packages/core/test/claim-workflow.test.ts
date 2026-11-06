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
const SELF = "github-actions[bot]";

type Said = { event: "commented"; id: number; body: string; login: string; created_at: string };
type Labelled = { event: "labeled" | "unlabeled"; name: string; actor: string; created_at: string };
type Other = { event: "assigned"; created_at: string };
type Item = Said | Labelled | Other;
type Permission = { permission: string; role_name?: string } | number;
type Scenario = {
	trigger: Said;
	pullRequest?: boolean;
	closed?: boolean;
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
		? { event: "commented", actor: { login: item.login }, ...asComment(item) }
		: item.event === "assigned"
			? { event: item.event, created_at: item.created_at }
			: { event: item.event, actor: { login: item.actor }, label: { name: item.name }, created_at: item.created_at };

// The script under test is the workflow's own text, run as github-script runs it. The fake holds one issue: its
// labels and its ordered timeline, from which it answers every read, and each write changes both, as GitHub would,
// under the workflow's own login. Each method checks that the request names exactly what it should, so a script that
// asks the wrong question fails rather than gets an answer.
async function run(scenario: Scenario) {
	const writes: unknown[] = [];
	const asked: string[] = [];
	const infos: string[] = [];
	const fail = { ...scenario.fail };
	const exact = (actual: unknown, expected: unknown) => expect(actual).toStrictEqual(expected);
	const write = (event: "labeled" | "unlabeled", name: string) =>
		scenario.timeline.push({ event, name, actor: SELF, created_at: "2026-11-05T12:00:00Z" });
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
					return {
						data: {
							state: scenario.closed ? "closed" : "open",
							labels: scenario.labels.map((name) => ({ name })),
						},
					};
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
	const core = { info: (message: string) => infos.push(message) };
	const body = new (Object.getPrototypeOf(async () => {}).constructor)("github", "context", "core", script);
	await body(github, context, core);
	return { writes, asked, infos, labels: scenario.labels };
}

const at = (second: number) => `2026-11-05T10:00:${String(second).padStart(2, "0")}Z`;
const label = (name: string, second: number, actor = "maintainer"): Labelled => ({
	event: "labeled",
	name,
	actor,
	created_at: at(second),
});
const unlabel = (name: string, second: number, actor = "maintainer"): Labelled => ({
	event: "unlabeled",
	name,
	actor,
	created_at: at(second),
});
const say = (id: number, login: string, second: number, body = `Claim: ${login}`): Said => ({
	event: "commented",
	id,
	body,
	login,
	created_at: at(second),
});
// What the workflow's own run writes after a claim, and after a release.
const claimed = (second: number) => [label(IN_PROGRESS, second, SELF), unlabel(READY, second, SELF)];
const released = (second: number) => [label(READY, second, SELF), unlabel(IN_PROGRESS, second, SELF)];
const decidedBy = (id: number) => `The issue reads "${IN_PROGRESS}", from ${commentUrl(id)}.`;

// Add before remove, so a run that fails between the two leaves both labels, which the next run repairs.
const toInProgress = [
	["add", IN_PROGRESS],
	["remove", READY],
];
const toReady = [
	["add", READY],
	["remove", IN_PROGRESS],
];

// A ready issue, labelled by a maintainer, whose last comment is the builder's claim, which triggered the run.
function claimScenario(overrides: Partial<Scenario> = {}): Scenario {
	const mine = say(20, "builder", 5);
	return {
		trigger: mine,
		labels: ["plan step", READY],
		timeline: [label(READY, 0), mine],
		permissions: { maintainer: "admin", builder: "write" },
		...overrides,
	};
}

describe("claim workflow policy", () => {
	it("runs on every new issue comment, with issues: write alone", () => {
		expect(workflow.on).toEqual({ issue_comment: { types: ["created"] } });
		expect(workflow.permissions).toEqual({ issues: "write" });
		expect(workflow.concurrency).toEqual({
			group: `claim-\${{ github.event.issue.number }}`,
			"cancel-in-progress": false,
		});
		expect(Object.keys(workflow.jobs)).toEqual(["swap-labels"]);
		expect(job.if).toBe(`\${{ !github.event.issue.pull_request }}`);
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
		const { writes, asked, infos } = await run(claimScenario());
		expect(writes).toEqual(toInProgress);
		expect(asked).toEqual(["maintainer", "builder"]);
		expect(infos).toEqual([decidedBy(20)]);
	});

	it.each(["admin", "write"])("accepts a claim from %s permission", async (permission) => {
		const { writes } = await run(claimScenario({ permissions: { maintainer: "admin", builder: permission } }));
		expect(writes).toEqual(toInProgress);
	});

	// The endpoint's legacy `permission` field folds maintain into write and triage into read; `role_name` names the role.
	it.each([
		[{ permission: "write", role_name: "maintain" }, toInProgress],
		[{ permission: "read", role_name: "triage" }, []],
	])("decides a writer from the endpoint's own response %j", async (permission, expected) => {
		const { writes } = await run(claimScenario({ permissions: { maintainer: "admin", builder: permission } }));
		expect(writes).toEqual(expected);
	});

	it.each(["read", "triage", "none"])("ignores a claim from %s permission", async (permission) => {
		const { writes, asked } = await run(claimScenario({ permissions: { maintainer: "admin", builder: permission } }));
		expect(writes).toEqual([]);
		expect(asked).toEqual(["maintainer", "builder"]);
	});

	it("asks once about a commenter who claims twice", async () => {
		const again = say(21, "builder", 6);
		const timeline = [label(READY, 0), say(20, "builder", 5), again];
		const { writes, asked } = await run(
			claimScenario({ trigger: again, timeline, permissions: { maintainer: "admin", builder: "read" } }),
		);
		expect(writes).toEqual([]);
		expect(asked).toEqual(["maintainer", "builder"]);
	});

	it("ignores a claim from someone the permission endpoint does not know", async () => {
		const { writes } = await run(claimScenario({ permissions: { maintainer: "admin", builder: 404 } }));
		expect(writes).toEqual([]);
	});

	it("fails without writing when the permission lookup errs", async () => {
		const scenario = claimScenario({ permissions: { maintainer: "admin", builder: 500 } });
		await expect(run(scenario)).rejects.toThrow("HTTP 500");
		expect(scenario.labels).toEqual(["plan step", READY]);
	});

	it("ignores a claim when no event ever labelled the issue ready", async () => {
		const mine = say(20, "builder", 5);
		const { writes } = await run(claimScenario({ timeline: [label("plan step", 0), mine] }));
		expect(writes).toEqual([]);
	});

	it("opens nothing on a triage user's ready label, and opens on a writer's later one", async () => {
		const early = say(10, "builder", 2);
		const mine = say(20, "builder", 5);
		const permissions = {
			triager: { permission: "read", role_name: "triage" },
			maintainer: "admin",
			builder: "write",
		};
		const shut = await run(
			claimScenario({ trigger: early, timeline: [label(READY, 0, "triager"), early], permissions }),
		);
		expect(shut.writes).toEqual([]);
		const timeline = [label(READY, 0, "triager"), early, label(READY, 3), mine];
		const { writes, infos } = await run(claimScenario({ timeline, permissions }));
		expect(writes).toEqual(toInProgress);
		expect(infos).toEqual([decidedBy(20)]);
	});

	it("keeps an earlier writer's claim against a second one", async () => {
		const mine = say(20, "builder", 5);
		const timeline = [label(READY, 0), say(10, "other", 2), ...claimed(3), mine];
		const { writes, infos } = await run(
			claimScenario({
				timeline,
				permissions: { maintainer: "admin", builder: "write", other: "admin" },
				labels: [IN_PROGRESS],
			}),
		);
		expect(writes).toEqual([]);
		expect(infos).toEqual([decidedBy(10)]);
	});

	it("is not blocked by a non-writer's earlier claim", async () => {
		const mine = say(20, "builder", 5);
		const timeline = [label(READY, 0), say(10, "stranger", 2), mine];
		const { writes } = await run(
			claimScenario({ timeline, permissions: { maintainer: "admin", builder: "write", stranger: "read" } }),
		);
		expect(writes).toEqual(toInProgress);
	});

	it("reopens claims on a writer's later ready label", async () => {
		const mine = say(20, "builder", 50);
		const timeline = [
			label(READY, 0),
			{ event: "assigned", created_at: at(5) } as const,
			say(5, "other", 10),
			...claimed(11),
			label(READY, 40),
			label("plan step", 41),
			mine,
		];
		const { writes, infos } = await run(
			claimScenario({
				trigger: mine,
				timeline,
				labels: ["plan step", IN_PROGRESS, READY],
				permissions: { maintainer: "admin", builder: "write", other: "write" },
			}),
		);
		expect(writes).toEqual([["remove", READY]]);
		expect(infos).toEqual([decidedBy(20)]);
	});

	it("orders a claim by the timeline, not its timestamp: one before the ready label loses at the same second", async () => {
		const mine = say(20, "builder", 9);
		const timeline = [say(10, "other", 4), label(READY, 4), mine];
		const { writes } = await run(
			claimScenario({
				trigger: mine,
				timeline,
				permissions: { maintainer: "admin", builder: "write", other: "write" },
			}),
		);
		expect(writes).toEqual(toInProgress);
	});

	it("ignores a claim posted before the issue was marked ready", async () => {
		const mine = say(20, "builder", 5);
		const { writes } = await run(claimScenario({ timeline: [mine, label(READY, 10)] }));
		expect(writes).toEqual([]);
	});

	it.each([" Claim: builder", "claim: builder", "Claim builder"])("ignores a comment %j", async (body) => {
		const mine = say(20, "builder", 5, body);
		const { writes, asked } = await run(claimScenario({ trigger: mine, timeline: [label(READY, 0), mine] }));
		expect(writes).toEqual([]);
		expect(asked).toEqual(["maintainer"]);
	});

	it("ignores a comment on a pull request", async () => {
		const { writes, asked } = await run(claimScenario({ pullRequest: true }));
		expect(writes).toEqual([]);
		expect(asked).toEqual([]);
	});

	it("applies an earlier writer's claim whose own run never ran, from a later claim's run", async () => {
		const mine = say(20, "builder", 5);
		const timeline = [label(READY, 0), say(10, "other", 2), mine];
		const { writes, asked } = await run(
			claimScenario({ timeline, permissions: { maintainer: "admin", builder: "write", other: "write" } }),
		);
		expect(writes).toEqual(toInProgress);
		expect(asked).toEqual(["maintainer", "other"]);
	});

	it("applies a claim from the run of any later comment", async () => {
		const thanks = say(30, "stranger", 9, "Thanks!");
		const timeline = [label(READY, 0), say(20, "builder", 5), thanks];
		const { writes } = await run(claimScenario({ trigger: thanks, timeline }));
		expect(writes).toEqual(toInProgress);
	});

	it("repairs a claim whose add failed when the run is retried", async () => {
		const scenario = claimScenario({ fail: { add: 503 } });
		await expect(run(scenario)).rejects.toThrow("HTTP 503");
		expect(scenario.labels).toEqual(["plan step", READY]);
		scenario.fail = undefined;
		const { writes, labels } = await run(scenario);
		expect(writes).toEqual(toInProgress);
		expect(labels).toEqual(["plan step", IN_PROGRESS]);
	});

	it("repairs a claim whose remove failed when the run is retried", async () => {
		const scenario = claimScenario({ fail: { remove: 503 } });
		await expect(run(scenario)).rejects.toThrow("HTTP 503");
		expect(scenario.labels).toEqual(["plan step", READY, IN_PROGRESS]);
		scenario.fail = undefined;
		const { writes, labels } = await run(scenario);
		expect(writes).toEqual([["remove", READY]]);
		expect(labels).toEqual(["plan step", IN_PROGRESS]);
	});

	it("writes nothing when the labels already match the claim", async () => {
		const { writes } = await run(claimScenario({ labels: ["plan step", IN_PROGRESS] }));
		expect(writes).toEqual([]);
	});

	it("undoes a hand removal of the ready label on the next comment", async () => {
		const mine = say(20, "builder", 5);
		const timeline = [label(READY, 0), unlabel(READY, 3), mine];
		const { writes } = await run(claimScenario({ timeline, labels: ["plan step"] }));
		expect(writes).toEqual([["add", IN_PROGRESS]]);
	});

	it("undoes a hand removal of the in-progress label on the next comment", async () => {
		const thanks = say(30, "stranger", 9, "Thanks!");
		const timeline = [label(READY, 0), say(20, "builder", 5), ...claimed(6), unlabel(IN_PROGRESS, 8), thanks];
		const { writes } = await run(claimScenario({ trigger: thanks, timeline, labels: ["plan step"] }));
		expect(writes).toEqual([["add", IN_PROGRESS]]);
	});

	it("ignores a writer's in-progress label", async () => {
		const thanks = say(30, "stranger", 9, "Thanks!");
		const timeline = [label(READY, 0), label(IN_PROGRESS, 4), thanks];
		const { writes } = await run(claimScenario({ trigger: thanks, timeline, labels: [READY, IN_PROGRESS] }));
		expect(writes).toEqual([["remove", IN_PROGRESS]]);
	});

	it("is not moved by the workflow's own label events", async () => {
		const thanks = say(30, "stranger", 9, "Thanks!");
		const timeline = [label(READY, 0), say(20, "builder", 5), ...claimed(6), ...released(7), thanks];
		const { writes, asked } = await run(
			claimScenario({
				trigger: thanks,
				timeline,
				labels: [READY],
				permissions: { maintainer: "admin", builder: "write", [SELF]: 404 },
			}),
		);
		expect(writes).toEqual(toInProgress);
		expect(asked).toEqual(["maintainer", "builder"]);
	});

	it("gives a claim posted between a release run's read and its writes the issue, not a later claim", async () => {
		const later = say(50, "late", 40);
		const timeline = [
			label(READY, 0),
			say(20, "builder", 5),
			...claimed(6),
			say(30, "maintainer", 10, "Released: no push for 24 hours"),
			say(40, "other", 11),
			...released(12),
			later,
		];
		const { writes, infos } = await run(
			claimScenario({
				trigger: later,
				timeline,
				labels: [READY],
				permissions: { maintainer: "admin", builder: "write", other: "write", late: "write" },
			}),
		);
		expect(writes).toEqual(toInProgress);
		expect(infos).toEqual([decidedBy(40)]);
	});
});

describe("release in the claim workflow script", () => {
	const release = say(30, "maintainer", 30, "Released: no push for 24 hours");
	const releaseScenario = (overrides: Partial<Scenario> = {}): Scenario => ({
		trigger: release,
		labels: ["plan step", IN_PROGRESS],
		timeline: [label(READY, 0), say(20, "builder", 5), ...claimed(6), release],
		permissions: { maintainer: "admin", builder: "write" },
		...overrides,
	});

	it("swaps in progress back to ready on a writer's release", async () => {
		const { writes, infos } = await run(releaseScenario());
		expect(writes).toEqual(toReady);
		expect(infos).toEqual([`The issue reads "${READY}", from ${commentUrl(30)}.`]);
	});

	it("ignores a release from a non-writer", async () => {
		const { writes } = await run(releaseScenario({ permissions: { maintainer: "read", builder: "write" } }));
		expect(writes).toEqual([]);
	});

	it("ignores a release on an issue nobody claimed, without asking who wrote it", async () => {
		const { writes, asked } = await run(
			releaseScenario({ labels: ["plan step", READY], timeline: [label(READY, 0, "builder"), release] }),
		);
		expect(writes).toEqual([]);
		expect(asked).toEqual(["builder"]);
	});

	it("ignores a writer's release on an issue never marked ready", async () => {
		const { writes } = await run(releaseScenario({ labels: ["plan step"], timeline: [release] }));
		expect(writes).toEqual([]);
	});

	it("applies a release from the run of any later comment", async () => {
		const thanks = say(40, "stranger", 40, "Thanks!");
		const scenario = releaseScenario({ trigger: thanks });
		scenario.timeline.push(thanks);
		const { writes } = await run(scenario);
		expect(writes).toEqual(toReady);
	});

	it("applies a release posted between a claim run's read and its writes", async () => {
		const timeline = [label(READY, 0), say(20, "builder", 5), release, ...claimed(31)];
		const { writes } = await run(releaseScenario({ timeline, labels: ["plan step", IN_PROGRESS] }));
		expect(writes).toEqual(toReady);
	});

	it("repairs a release whose add failed when the run is retried", async () => {
		const scenario = releaseScenario({ fail: { add: 503 } });
		await expect(run(scenario)).rejects.toThrow("HTTP 503");
		expect(scenario.labels).toEqual(["plan step", IN_PROGRESS]);
		scenario.fail = undefined;
		const { writes, labels } = await run(scenario);
		expect(writes).toEqual(toReady);
		expect(labels).toEqual(["plan step", READY]);
	});

	it("repairs a release whose remove failed when the run is retried", async () => {
		const scenario = releaseScenario({ fail: { remove: 503 } });
		await expect(run(scenario)).rejects.toThrow("HTTP 503");
		expect(scenario.labels).toEqual(["plan step", IN_PROGRESS, READY]);
		scenario.fail = undefined;
		const { writes, labels } = await run(scenario);
		expect(writes).toEqual([["remove", IN_PROGRESS]]);
		expect(labels).toEqual(["plan step", READY]);
	});

	it("writes nothing when the labels already match the release", async () => {
		const { writes } = await run(releaseScenario({ labels: ["plan step", READY] }));
		expect(writes).toEqual([]);
	});

	it("lets the next writer's claim take a released issue", async () => {
		const next = say(40, "other", 40);
		const scenario = releaseScenario({
			trigger: next,
			labels: ["plan step", READY],
			permissions: { maintainer: "admin", builder: "write", other: "write" },
		});
		scenario.timeline.push(...released(31), next);
		const { writes, infos } = await run(scenario);
		expect(writes).toEqual(toInProgress);
		expect(infos).toEqual([decidedBy(40)]);
	});
});
