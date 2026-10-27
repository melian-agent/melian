import { PullRequestRoundsReader } from "@melian-agent/github";
import { type GitHubRecording, recordedGitHub } from "@melian-agent/github/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const base = "a".repeat(40);
const head = "b".repeat(40);
const old = "c".repeat(40);
const info = (hasNextPage = false, endCursor: string | null = null) => ({ hasNextPage, endCursor });
const pull = (connection: Record<string, unknown>) => ({
	data: { repository: { pullRequest: { baseRefOid: base, headRefOid: head, mergeCommit: null, ...connection } } },
});
const commits = (oids: string[], hasNext = false, cursor: string | null = null) =>
	pull({
		commits: { totalCount: 1, nodes: oids.map((oid) => ({ commit: { oid } })), pageInfo: info(hasNext, cursor) },
	});
const pushes = (before: string | null, after: string | null, hasNext = false, cursor: string | null = null) =>
	pull({
		timelineItems: {
			totalCount: 5000,
			nodes: [
				{
					beforeCommit: before === null ? null : { oid: before },
					afterCommit: after === null ? null : { oid: after },
				},
			],
			pageInfo: info(hasNext, cursor),
		},
	});
const associations = (numbers: number[], hasNext = false, cursor: string | null = null) => ({
	data: {
		repository: {
			object: {
				associatedPullRequests: {
					nodes: numbers.map((number) => ({ number, repository: { name: "repo", owner: { login: "owner" } } })),
					pageInfo: info(hasNext, cursor),
				},
			},
		},
	},
});
const defaults = {
	MelianRoundCommits: [commits([head])],
	MelianRoundPushes: [pushes(old, head)],
	MelianRoundAssociations: [associations([7])],
};

beforeEach(() =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("unexpected network");
		}),
	),
);
afterEach(() => vi.unstubAllGlobals());

function reader(graphql: GitHubRecording["graphql"] = defaults, apiUrl?: string) {
	const requests: { query: string; variables: Record<string, unknown>; url: string }[] = [];
	const answer = recordedGitHub({ owner: "owner", repo: "repo", graphql });
	const fetch: typeof globalThis.fetch = async (input, init) => {
		requests.push({ ...JSON.parse(String(init?.body)), url: String(input) } as (typeof requests)[number]);
		return answer(input, init);
	};
	return {
		opened: PullRequestRoundsReader.open({
			owner: "owner",
			repo: "repo",
			pullRequest: 7,
			token: "test",
			fetch,
			...(apiUrl === undefined ? {} : { apiUrl }),
		}),
		requests,
	};
}

it("pages all connections by hasNextPage, ignoring filtered totalCount", async () => {
	const { opened, requests } = reader({
		MelianRoundCommits: [commits([head], true, "commits-1"), commits([old])],
		MelianRoundPushes: [pushes(null, old, true, "pushes-1"), pushes(old, head)],
		MelianRoundAssociations: [associations([7], true, "associated-1"), associations([12])],
	});
	expect(await opened.read()).toEqual({
		repository: { owner: "owner", name: "repo" },
		number: 7,
		base,
		head,
		merge: null,
		commits: [head, old],
		forcePushes: [
			{ before: null, after: old },
			{ before: old, after: head },
		],
		associated: { [head]: [7, 12], [old]: [7, 12] },
	});
	expect(requests.map((request) => request.variables.after)).toEqual([
		null,
		"commits-1",
		null,
		"pushes-1",
		null,
		"associated-1",
		null,
		"associated-1",
	]);
	for (const { query, variables } of requests) {
		expect(query).toContain("repository(owner: $owner, name: $name)");
		expect(query).toContain("pageInfo { hasNextPage endCursor }");
		expect(variables).toMatchObject({ owner: "owner", name: "repo", number: 7 });
		if (query.includes("MelianRoundAssociations")) {
			expect(query).toContain("object(oid: $oid)");
			expect(query).toContain("associatedPullRequests(first: 100, after: $after)");
			expect(query).toContain("number repository { name owner { login } }");
			expect(query).not.toContain("states:");
			expect([head, old]).toContain(variables.oid);
		} else {
			expect(query).toContain("pullRequest(number: $number)");
			expect(query).toContain("baseRefOid headRefOid mergeCommit { oid }");
			if (query.includes("MelianRoundCommits")) expect(query).toContain("commits(first: 100, after: $after)");
			else {
				expect(query).toContain("itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]");
				expect(query).toContain("beforeCommit { oid } afterCommit { oid }");
			}
		}
	}
});
it.each([249, 250, 251])("refuses commit cap at %i commits", async (count) => {
	const { opened } = reader({ ...defaults, MelianRoundCommits: [commits(Array<string>(count).fill(head))] });
	if (count < 250) await expect(opened.read()).resolves.toMatchObject({ commits: Array<string>(count).fill(head) });
	else await expect(opened.read()).rejects.toThrow("250");
});
it.each(["MelianRoundCommits", "MelianRoundPushes", "MelianRoundAssociations"])(
	"fails closed on a failed later %s page",
	async (operation) => {
		const first =
			operation === "MelianRoundCommits"
				? commits([head], true, "next")
				: operation === "MelianRoundPushes"
					? pushes(old, head, true, "next")
					: associations([7], true, "next");
		await expect(reader({ ...defaults, [operation]: [first] }).opened.read()).rejects.toThrow(
			"no snapshot was refreshed",
		);
	},
);
it.each([null, "same"])("refuses missing or repeated pagination cursor %s", async (cursor) => {
	const first = commits([head], true, cursor);
	await expect(reader({ ...defaults, MelianRoundCommits: [first, first] }).opened.read()).rejects.toThrow("cursor");
});
it("refuses inconsistent head, base or merge facts on later pages", async () => {
	for (const change of [{ headRefOid: old }, { baseRefOid: old }, { mergeCommit: { oid: old } }]) {
		const later = commits([old]);
		Object.assign(later.data.repository.pullRequest, change);
		await expect(
			reader({ ...defaults, MelianRoundCommits: [commits([head], true, "next"), later] }).opened.read(),
		).rejects.toThrow("moved");
	}
});
it.each([
	null,
	{},
	{ nodes: [null], pageInfo: info() },
	{ nodes: [], pageInfo: { hasNextPage: "false", endCursor: null } },
	{ nodes: [], pageInfo: { hasNextPage: false, endCursor: 2 } },
	{ nodes: [{ commit: { oid: "bad" } }], pageInfo: info() },
])("refuses partial connections %j", async (commits) => {
	await expect(reader({ ...defaults, MelianRoundCommits: [pull({ commits })] }).opened.read()).rejects.toThrow(
		/membership/,
	);
});
it("keeps missing push endpoints and merged commit facts", async () => {
	const first = commits([head]);
	first.data.repository.pullRequest.mergeCommit = { oid: old } as unknown as null;
	const second = pushes(null, null);
	second.data.repository.pullRequest.mergeCommit = { oid: old } as unknown as null;
	expect(
		await reader({ ...defaults, MelianRoundCommits: [first], MelianRoundPushes: [second] }).opened.read(),
	).toMatchObject({ merge: old, forcePushes: [{ before: null, after: null }] });
});

it("requests historical force-push heads even when commits and current head do not name them", async () => {
	for (const push of [pushes(old, null), pushes(null, old)]) {
		const { opened, requests } = reader({ ...defaults, MelianRoundPushes: [push] });
		expect((await opened.read()).associated).toEqual({ [head]: [7], [old]: [7] });
		expect(
			requests
				.filter(({ query }) => query.includes("MelianRoundAssociations"))
				.map(({ variables }) => variables.oid),
		).toEqual([head, old]);
	}
});
it("uses the configured API endpoint for every membership request", async () => {
	const { opened, requests } = reader(defaults, "https://api.example.test");
	await opened.read();
	expect(requests.map(({ url }) => url)).toEqual(Array<string>(4).fill("https://api.example.test/graphql"));
});
it.each([0, "page", false, []])("rejects a primitive or array connection %j", async (connection) => {
	await expect(
		reader({ ...defaults, MelianRoundCommits: [pull({ commits: connection })] }).opened.read(),
	).rejects.toThrow("membership");
});
it.each([[head], `x${head}`, `${head}x`])("rejects a noncanonical commit %j", async (value) => {
	const page = pull({ commits: { nodes: [{ commit: { oid: value } }], pageInfo: info() } });
	await expect(reader({ ...defaults, MelianRoundCommits: [page] }).opened.read()).rejects.toThrow("membership commit");
});
it.each([50, 51])("enforces the page limit at %i pages", async (count) => {
	const pages = Array.from({ length: count }, (_, i) => commits([head], i < count - 1, `page-${i}`));
	const result = reader({ ...defaults, MelianRoundCommits: pages }).opened.read();
	if (count === 50) await expect(result).resolves.toMatchObject({ commits: Array<string>(50).fill(head) });
	else await expect(result).rejects.toThrow("50 pages");
});

it.each([0, -1, 1.5, "7"])("rejects invalid associated pull request number %j", async (number) => {
	const page = associations([7]);
	(page.data.repository.object.associatedPullRequests.nodes[0] as { number: unknown }).number = number;
	await expect(reader({ ...defaults, MelianRoundAssociations: [page] }).opened.read()).rejects.toThrow(
		"invalid associated pull request number",
	);
});
it("includes association number one and excludes each other-repository operand independently", async () => {
	const page = associations([1, 7, 8, 9]);
	page.data.repository.object.associatedPullRequests.nodes[2]!.repository.name = "other";
	page.data.repository.object.associatedPullRequests.nodes[3]!.repository.owner.login = "other";
	expect((await reader({ ...defaults, MelianRoundAssociations: [page] }).opened.read()).associated).toEqual({
		[head]: [1, 7],
		[old]: [1, 7],
	});
});
it.each([
	{ nodes: {}, pageInfo: info() },
	{ nodes: [], pageInfo: { hasNextPage: false } },
])("rejects missing connection fields independently %j", async (connection) => {
	await expect(
		reader({ ...defaults, MelianRoundCommits: [pull({ commits: connection })] }).opened.read(),
	).rejects.toThrow("membership connection");
});

it.each([{ nodes: [] }, { nodes: [], pageInfo: { hasNextPage: 0, endCursor: null } }])(
	"rejects independent page-info omissions %j",
	async (connection) => {
		await expect(
			reader({ ...defaults, MelianRoundCommits: [pull({ commits: connection })] }).opened.read(),
		).rejects.toThrow("membership");
	},
);

it.each(["name", "owner"])("rejects missing associated repository %s", async (field) => {
	const page = associations([7]);
	const repository = page.data.repository.object.associatedPullRequests.nodes[0]!.repository as Record<
		string,
		unknown
	>;
	if (field === "name") repository.name = 2;
	else repository.owner = { login: 2 };
	await expect(reader({ ...defaults, MelianRoundAssociations: [page] }).opened.read()).rejects.toThrow(
		"invalid associated pull request repository",
	);
});
