import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
	Adjudication,
	Comparison,
	defaultConfig,
	pullRequestChangesetId,
	type StoredComparison,
} from "@melian-agent/core";
import {
	CompareHarness,
	backgroundContext as context,
	MembershipReader,
	openSqliteStorage,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, temporaryDirectory } from "../../core/test/fixtures/repo.ts";
import { ComparisonDocument } from "../../pipeline/src/compare.ts";
import { defineDoc } from "../../pipeline/src/harness.ts";
import { PublisherDocument } from "../../pipeline/src/publish.ts";
import { PullRequestRoundsDocument } from "../../pipeline/src/pull-request-rounds.ts";
import { RoundsDocument } from "../../pipeline/src/rounds.ts";
import type { Io } from "../src/commands.ts";
import { ComparisonStores } from "../src/comparison-stores.ts";
import { main } from "../src/main.ts";
import { storagePath } from "../src/repository.ts";

vi.mock("node:fs/promises", { spy: true });

const repository = { owner: "owner", name: "repo" };
const own = pullRequestChangesetId("github", repository, 7);
const foreign = "range-0123456789abcdef";
const earlierPull = "pull-0000000000000000";
let base: string;
let head: string;
const at = "2026-11-04T00:00:00Z";
const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
	.adjudicate()
	.toJSON();
const kinds = ["comparison", "rounds", "publisher"] as const;
type Kind = (typeof kinds)[number] | "history";
let repo: string;
let io: Io;
let ownPath: string;
let ownComparison: StoredComparison;

beforeEach(async () => {
	vi.mocked(fs.readdir).mockReset();
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "base");
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "-qm", "base");
	base = gitIn(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "a.txt"), "head");
	gitIn(repo, "commit", "-qam", "head");
	head = gitIn(repo, "rev-parse", "HEAD");
	gitIn(repo, "remote", "add", "origin", "git@github.com:owner/repo.git");
	const recording = join(repo, "github.json");
	const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
	const pull = { baseRefOid: base, headRefOid: head, mergeCommit: null };
	writeFileSync(
		recording,
		JSON.stringify({
			owner: "owner",
			repo: "repo",
			graphql: {
				MelianRoundCommits: [
					{ data: { repository: { pullRequest: { ...pull, commits: connection([{ commit: { oid: head } }]) } } } },
				],
				MelianRoundPushes: [{ data: { repository: { pullRequest: { ...pull, timelineItems: connection([]) } } } }],
				MelianRoundAssociations: [
					{
						data: {
							repository: {
								object: {
									associatedPullRequests: connection([
										{ number: 7, repository: { name: "repo", owner: { login: "owner" } } },
									]),
								},
							},
						},
					},
				],
			},
		}),
	);
	vi.stubEnv("GIT_SSH_COMMAND", "false");
	io = {
		cwd: repo,
		env: { MELIAN_TEST_SCRIPT: "unused.json", MELIAN_TEST_GITHUB: recording, MELIAN_STATE_DIR: join(repo, "state") },
		color: false,
		stdout: vi.fn(),
		stderr: vi.fn(),
	};
	ownPath = await storagePath(repo, own, io.env, true);
	ownComparison = await seed(own);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(repo, { recursive: true, force: true });
});
function output() {
	return vi
		.mocked(io.stdout)
		.mock.calls.map(([text]) => text)
		.join("");
}
function errors() {
	return vi
		.mocked(io.stderr)
		.mock.calls.map(([text]) => text)
		.join("");
}
async function seed(changeset: string) {
	const harness = await CompareHarness.open(
		await openSqliteStorage(await storagePath(repo, changeset, io.env, true)),
		createFakeModels().review,
		changeset,
	);
	try {
		const root = await harness.harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(RoundsDocument, root.id)).items.r1 = { base, head, mintedAt: at, tasks: [], verdict };
		}, context);
		return (await harness.importFindings({ base, head, round: `${changeset}.r1` }, [], at)).toJSON();
	} finally {
		await harness.close();
	}
}
// Synthetic version probes use current document definitions and values, not a future build's fixture.
async function newer(kind: Kind, changeset: string) {
	const definition = {
		comparison: ComparisonDocument.definition,
		rounds: RoundsDocument.definition,
		publisher: PublisherDocument.definition,
		history: PullRequestRoundsDocument.definition,
	}[kind];
	const harness = await CompareHarness.open(
		await openSqliteStorage(await storagePath(repo, changeset, io.env, true)),
		createFakeModels().review,
		changeset,
	);
	try {
		const root = await harness.harness.root(context);
		const probe = defineDoc({
			kind: definition.kind,
			version: definition.version + 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => definition.initial(),
			migrate: () => definition.initial(),
		});
		await root.commit(async (tx) => {
			Object.assign(await tx.doc(probe, root.id), definition.initial());
		}, context);
	} finally {
		await harness.close();
	}
}
function refusal(kind: Kind) {
	const definition = {
		comparison: ComparisonDocument.definition,
		rounds: RoundsDocument.definition,
		publisher: PublisherDocument.definition,
		history: PullRequestRoundsDocument.definition,
	}[kind];
	const label = kind === "comparison" ? "comparison document" : definition.kind;
	return `melian: ${label} has newer version ${definition.version + 1}\n`;
}
async function saveSnapshot(changeset = own) {
	const harness = await CompareHarness.open(await openSqliteStorage(ownPath), createFakeModels().review, own);
	try {
		return await harness.refreshMembership(
			{ repository, number: 7, base, head, merge: null, commits: [head], forcePushes: [], associated: {} },
			[
				{
					id: `${changeset}.r1`,
					base,
					head,
					mintedAt: at,
					status: "member",
					reason: "exact pull request merge base",
				},
			],
			"",
			at,
		);
	} finally {
		await harness.close();
	}
}
async function history() {
	const storage = await openSqliteStorage(ownPath);
	try {
		return (await MembershipReader.open(storage).history()).versions;
	} finally {
		await storage.close(context);
	}
}
function expected(comparisons = { [`${own}.r1`]: ownComparison }, unattributed = {}) {
	return `${JSON.stringify({ comparisons, unattributed }, null, 2)}\n`;
}
it.each(kinds)("F1-F3 compatibility export ignores a foreign newer %s", async (kind) => {
	await seed(foreign);
	await newer(kind, foreign);
	expect(await main(["compare", "export", "#7", "--json"], io), errors()).toBe(0);
	expect({ output: output(), errors: errors() }).toEqual({ output: expected(), errors: "" });
	expect(await history()).toEqual([]);
});
it("F4 compatibility export reads its own store before a lexically earlier pull", async () => {
	expect(earlierPull < own).toBe(true);
	await seed(earlierPull);
	await newer("comparison", earlierPull);
	expect(await main(["compare", "export", "#7", "--json"], io), errors()).toBe(0);
	expect({ output: output(), errors: errors() }).toEqual({ output: expected(), errors: "" });
});
it("F5 missing own store reports no snapshot without opening another store or creating its own", async () => {
	rmSync(ownPath);
	await seed(foreign);
	await newer("comparison", foreign);
	expect(await main(["compare", "export", "#7", "--json"], io)).toBe(1);
	expect({ output: output(), errors: errors(), exists: existsSync(ownPath) }).toEqual({
		output: "",
		errors: 'melian: no membership snapshot; run melian compare "#7" first\n',
		exists: false,
	});
});
it.each(["bare", "refresh"])("%s still reads foreign candidates before any membership write", async (command) => {
	await seed(foreign);
	await newer("publisher", foreign);
	expect(await main(["compare", ...(command === "bare" ? [] : ["refresh"]), "#7"], io)).toBe(1);
	expect({ output: output(), errors: errors(), history: await history() }).toEqual({
		output: "",
		errors: refusal("publisher"),
		history: [],
	});
});
it.each(kinds)("compatibility export refuses its own newer %s and preserves --out", async (kind) => {
	await newer(kind, own);
	const out = join(repo, "export.json");
	writeFileSync(out, "previous export");
	expect(await main(["compare", "export", "#7", "--json", "--out", out], io)).toBe(1);
	expect({ output: output(), errors: errors(), out: readFileSync(out, "utf8") }).toEqual({
		output: "",
		errors: refusal(kind),
		out: "previous export",
	});
});
it.each(kinds)("snapshot export still refuses a foreign catalogue's newer %s", async (kind) => {
	await seed(earlierPull);
	await seed(foreign);
	const snapshot = await saveSnapshot();
	await newer(kind, foreign);
	expect(await main(["compare", "export", "#7", "--json"], io)).toBe(1);
	expect({ output: output(), errors: errors(), history: await history() }).toEqual({
		output: "",
		errors: refusal(kind),
		history: [snapshot],
	});
});
it.each(kinds)("snapshot export still refuses a member store's newer %s", async (kind) => {
	await seed(foreign);
	const snapshot = await saveSnapshot(foreign);
	await newer(kind, foreign);
	expect(await main(["compare", "export", "#7", "--json"], io)).toBe(1);
	expect({ output: output(), errors: errors(), history: await history() }).toEqual({
		output: "",
		errors: refusal(kind),
		history: [snapshot],
	});
});
it("compatibility export refuses its own newer current history", async () => {
	await newer("history", own);
	expect(await main(["compare", "export", "#7", "--json"], io)).toBe(1);
	expect({ output: output(), errors: errors() }).toEqual({ output: "", errors: refusal("history") });
});
it("snapshot export includes saved members from other stores", async () => {
	const comparison = await seed(foreign);
	const snapshot = await saveSnapshot(foreign);
	expect(await main(["compare", "export", "#7", "--json"], io), errors()).toBe(0);
	const record = {
		comparisons: { [`${foreign}.r1`]: comparison },
		unattributed: {},
		membership: snapshot,
		history: [snapshot],
	};
	expect({ output: output(), errors: errors() }).toEqual({
		output: `${JSON.stringify(record, null, 2)}\n`,
		errors: "",
	});
});
it("compatibility raw scope includes only its own records with their full revision identity", async () => {
	await seed(foreign);
	const raw = Comparison.of({ base, head }).toJSON();
	for (const changeset of [own, foreign]) {
		const harness = await CompareHarness.open(
			await openSqliteStorage(await storagePath(repo, changeset, io.env, true)),
			createFakeModels().review,
			changeset,
		);
		try {
			const root = await harness.harness.root(context);
			await root.commit(async (tx) => {
				(await tx.doc(ComparisonDocument, root.id)).unattributed[`${base}..${head}`] = raw;
			}, context);
		} finally {
			await harness.close();
		}
	}
	expect(await main(["compare", "export", "#7", "--json"], io), errors()).toBe(0);
	expect({ output: output(), errors: errors() }).toEqual({
		output: expected(undefined, { [`${base}..${head}`]: raw }),
		errors: "",
	});
});

it("snapshot catalogue ignores files outside the store filename whitelist", async () => {
	const snapshot = await saveSnapshot();
	for (const name of [`prefix-${foreign}.sqlite`, `${foreign}.sqlite.backup`, "unrelated.txt"])
		writeFileSync(join(ownPath, "..", name), "not SQLite");
	expect(await main(["compare", "export", "#7", "--json"], io), errors()).toBe(0);
	const record = {
		comparisons: { [`${own}.r1`]: ownComparison },
		unattributed: {},
		membership: snapshot,
		history: [snapshot],
	};
	expect({ output: output(), errors: errors() }).toEqual({
		output: `${JSON.stringify(record, null, 2)}\n`,
		errors: "",
	});
});
it("sorts the complete refresh catalogue independently of filesystem enumeration order", async () => {
	const comparison = await seed(foreign);
	vi.spyOn(fs, "readdir").mockImplementation(async (path) => {
		expect(path).toBe(join(ownPath, ".."));
		return [`${foreign}.sqlite`, `${own}.sqlite`] as never;
	});
	const stores = await ComparisonStores.read(io, { repository, pullRequest: 7 });
	expect(
		stores.entries.map((entry) => ({
			...entry,
			comparison: entry.comparison.toJSON(),
			verdict: entry.verdict?.toJSON(),
		})),
	).toEqual([
		{ changeset: own, round: `${own}.r1`, comparison: ownComparison, verdict },
		{ changeset: foreign, round: `${foreign}.r1`, comparison, verdict },
	]);
	expect(stores.candidates).toEqual(
		[own, foreign].map((changeset) => ({ id: `${changeset}.r1`, base, head, mintedAt: at })),
	);
	expect([...stores.histories].map(([id, history]) => [id, history.versions])).toEqual([[own, []]]);
});
it("range export retains its dispatch before a comparison exists", async () => {
	expect(await main(["compare", "export", "main...HEAD", "--json"], io)).toBe(1);
	expect({ output: output(), errors: errors() }).toEqual({
		output: "",
		errors: "melian: no comparison recorded; run melian compare main...HEAD first\n",
	});
});
it("export context without requested history treats the absent history as no snapshot", async () => {
	await seed(foreign);
	await newer("publisher", foreign);
	const stores = await ComparisonStores.read(io, { repository, pullRequest: 7 }, false, true);
	expect(
		stores.entries.map((entry) => ({
			...entry,
			comparison: entry.comparison.toJSON(),
			verdict: entry.verdict?.toJSON(),
		})),
	).toEqual([{ changeset: own, round: `${own}.r1`, comparison: ownComparison, verdict }]);
	expect(stores.candidates).toEqual([{ id: `${own}.r1`, base, head, mintedAt: at }]);
	expect([...stores.histories]).toEqual([]);
});
