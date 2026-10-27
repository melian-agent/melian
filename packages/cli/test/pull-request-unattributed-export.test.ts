import { copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ComparisonEntry,
	ComparisonError,
	ComparisonExport,
	ExternalFinding,
	PullRequestMembership,
	pullRequestChangesetId,
	type StoredComparison,
} from "@melian-agent/core";
import {
	CompareHarness,
	ComparisonReader,
	backgroundContext as context,
	MembershipReader,
	openSqliteStorage,
	type PullRequestRoundHistory,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, temporaryDirectory } from "../../core/test/fixtures/repo.ts";
import { PublisherDocument } from "../../pipeline/src/publish.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import { storagePath } from "../src/repository.ts";

const fixture = new URL("../../pipeline/test/fixtures/comparison-rounds/build1-0ee97219/", import.meta.url);
const recorded = JSON.parse(readFileSync(new URL("recorded.json", fixture), "utf8")) as {
	external: string;
	revisions: { base: string; head: string }[];
};
const revision = recorded.revisions[0]!;
const key = `${revision.base}..${revision.head}`;
const changeset = pullRequestChangesetId("github", { owner: "owner", name: "repo" }, 7);
let repo: string;
let io: Io;
let original: StoredComparison;
let markdown: string;
const output = () =>
	vi
		.mocked(io.stdout)
		.mock.calls.map(([text]) => text)
		.join("");

beforeEach(async () => {
	for (const [name, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(name, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.ts"), "export const current = 1;\n");
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "-qm", "current checkout");
	const head = gitIn(repo, "rev-parse", "HEAD");
	gitIn(repo, "remote", "add", "origin", "git@github.com:owner/repo.git");
	const recording = join(repo, "github.json");
	const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
	const pull = { baseRefOid: head, headRefOid: head, mergeCommit: null };
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
	io = {
		cwd: repo,
		env: { MELIAN_TEST_SCRIPT: "unused.json", MELIAN_TEST_GITHUB: recording, MELIAN_STATE_DIR: join(repo, "state") },
		color: false,
		stdout: vi.fn(),
		stderr: vi.fn(),
	};
	const path = await storagePath(repo, changeset, io.env, true);
	copyFileSync(new URL("comparisons.sqlite", fixture), path);
	const storage = await openSqliteStorage(path);
	try {
		const entries = await ComparisonReader.open(storage).read(changeset);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.round).toBeUndefined();
		expect(entries[0]!.unattributed).toBe(key);
		original = entries[0]!.comparison.toJSON();
		expect(original.adjudications?.[recorded.external]?.history).toHaveLength(1);
		markdown = new ComparisonExport(entries, "#7", "https://github.com/owner/repo/pull/7").render();
	} finally {
		await storage.close(context);
	}
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

it.each(["json", "markdown"])(
	"preserves captured unattributed comparison matches and adjudications in %s before and after the first membership snapshot",
	async (format) => {
		const args = ["compare", "export", "#7", ...(format === "json" ? ["--json"] : [])];
		expect(await main(args, io)).toBe(0);
		if (format === "json") {
			const before = JSON.parse(output()) as {
				comparisons: Record<string, StoredComparison>;
				unattributed: Record<string, StoredComparison>;
			};
			expect(before.comparisons).toEqual({});
			expect(before.unattributed).toEqual({ [key]: original });
		} else expect(output()).toBe(markdown);
		vi.mocked(io.stdout).mockClear();
		expect(await main(["compare", "#7"], io)).toBe(0);
		vi.mocked(io.stdout).mockClear();
		expect(await main(args, io)).toBe(0);
		if (format === "json") {
			const after = JSON.parse(output()) as {
				comparisons: Record<string, StoredComparison>;
				unattributed: Record<string, StoredComparison>;
			};
			expect(after.comparisons).toEqual({});
			expect(after.unattributed).toEqual({ [key]: original });
			expect(after.unattributed[key]!.matches).toEqual(original.matches);
			expect(after.unattributed[key]!.adjudications).toEqual(original.adjudications);
		} else expect(output()).toContain(markdown);
	},
);

it.each([
	[7, false, true],
	[7, true, true],
	[8, false, false],
])(
	"retains captured raw comparisons only in a member-holding range store (publication #%i, unreachable %s)",
	async (number, unreachable, keep) => {
		const range = "range-1111111111111111";
		const path = await storagePath(repo, range, io.env, true);
		renameSync(await storagePath(repo, changeset, io.env, true), path);
		const harness = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review, range);
		try {
			const root = await harness.harness.root(context);
			await root.commit(async (tx) => {
				(await tx.doc(PublisherDocument, root.id)).target = {
					repository: "owner/repo",
					pullRequest: number,
					baseRef: "main",
					baseTip: revision.base,
					base: revision.base,
					head: revision.head,
					revision: key,
					roundId: "r1",
				};
			}, context);
		} finally {
			await harness.close();
		}
		expect(await main(["compare", "#7"], io)).toBe(0);
		if (unreachable) {
			vi.spyOn(PullRequestMembership.prototype, "headAvailable").mockResolvedValue(false);
			vi.mocked(io.stdout).mockClear();
			expect(await main(["compare", "refresh", "#7"], io)).toBe(0);
			expect(output()).toContain(`Round 1: ${range}.r1 (unreachable)`);
		}
		vi.mocked(io.stdout).mockClear();
		expect(await main(["compare", "export", "#7", "--json"], io)).toBe(0);
		const exported = JSON.parse(output()) as {
			comparisons: Record<string, StoredComparison>;
			unattributed: Record<string, StoredComparison>;
		};
		expect(exported.comparisons).toEqual({});
		expect(exported.unattributed).toEqual(keep ? { [key]: original } : {});
	},
);

it.each(["json", "markdown"])(
	"preserves both allowed-store records when their revision keys collide in %s",
	async (format) => {
		const range = "range-2222222222222222";
		const entries: ComparisonEntry[] = [];
		for (const [store, note] of [
			[changeset, "Pull-only maintainer decision"],
			[range, "Range-only maintainer decision"],
		] as const) {
			const path = await storagePath(repo, store!, io.env, true);
			if (store === range) copyFileSync(new URL("comparisons.sqlite", fixture), path);
			const harness = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review, store);
			try {
				await harness.adjudicate({ ...revision, round: "unattributed" }, recorded.external, {
					verdict: "noise",
					by: "Current fixture writer",
					at: "2026-10-27T00:00:00Z",
					note,
				});
				if (store === range) {
					const root = await harness.harness.root(context);
					await root.commit(async (tx) => {
						(await tx.doc(PublisherDocument, root.id)).target = {
							repository: "owner/repo",
							pullRequest: 7,
							baseRef: "main",
							baseTip: revision.base,
							base: revision.base,
							head: revision.head,
							revision: key,
							roundId: "r1",
						};
					}, context);
				}
			} finally {
				await harness.close();
			}
			const storage = await openSqliteStorage(path);
			try {
				entries.push(...(await ComparisonReader.open(storage).read(store!)));
			} finally {
				await storage.close(context);
			}
		}
		expect(entries).toHaveLength(2);
		for (const entry of entries) expect(entry.comparison.adjudication(recorded.external)?.history).toHaveLength(2);
		const record = new ComparisonExport(entries, "#7", "https://github.com/owner/repo/pull/7");
		expect(record.render()).toContain("Pull-only maintainer decision");
		expect(record.render()).toContain("Range-only maintainer decision");
		if (format === "json") expect(() => record.renderJson()).toThrowError(ComparisonError);
		if (format === "json")
			expect(() => record.renderJson()).toThrowError(
				expect.objectContaining({
					name: "ComparisonError",
					code: "unattributedCollision",
				}),
			);
		vi.mocked(io.stdout).mockClear();
		expect(await main(["compare", "#7"], io)).toBe(0);
		vi.mocked(io.stdout).mockClear();
		if (format === "json") {
			const path = join(repo, "existing.json");
			writeFileSync(path, "previous export");
			expect(await main(["compare", "export", "#7", "--json", "--out", path], io)).toBe(1);
			expect(readFileSync(path, "utf8")).toBe("previous export");
			const error = vi
				.mocked(io.stderr)
				.mock.calls.map(([text]) => text)
				.join("");
			for (const value of [key, changeset, range, "Markdown"]) expect(error).toContain(value);
		} else {
			expect(await main(["compare", "export", "#7"], io)).toBe(0);
			expect(output()).toContain("Pull-only maintainer decision");
			expect(output()).toContain("Range-only maintainer decision");
		}
	},
);

it("needs no git author for a membership read or ordinary refresh, and refuses explicit acceptance without one", async () => {
	vi.stubEnv("GIT_AUTHOR_NAME", "");
	vi.stubEnv("GIT_AUTHOR_EMAIL", "");
	gitIn(repo, "config", "user.useConfigOnly", "true");
	expect(await main(["compare", "#7"], io)).toBe(0);
	expect(await main(["compare", "refresh", "#7"], io)).toBe(0);
	expect(await main(["compare", "refresh", "#7", "--accept"], io)).toBe(1);
	expect(
		vi
			.mocked(io.stderr)
			.mock.calls.map(([text]) => text)
			.join(""),
	).toContain("set user.name and user.email");
	vi.mocked(io.stdout).mockClear();
	expect(await main(["compare", "export", "#7", "--json"], io)).toBe(0);
	const result = JSON.parse(output()) as { history: { version: number; audit: unknown[] }[] };
	expect(result.history.map((snapshot) => ({ version: snapshot.version, audit: snapshot.audit }))).toEqual([
		{ version: 1, audit: [] },
		{ version: 2, audit: [] },
	]);
});

it.each(["stdout", "file"])(
	"escapes the final JSON boundary on %s without changing reviewer or snapshot values",
	async (destination) => {
		const codepoints = [
			...Array.from({ length: 32 }, (_, i) => i),
			...Array.from({ length: 33 }, (_, i) => 0x7f + i),
			0x061c,
			0x200e,
			0x200f,
			0x2028,
			0x2029,
			...Array.from({ length: 5 }, (_, i) => 0x202a + i),
			...Array.from({ length: 4 }, (_, i) => 0x2066 + i),
		];
		const controls = codepoints.map((code) => String.fromCodePoint(code));
		const hostile = `raw:${controls.join("|")} literal:\\u202e quote:" slash:\\ end`;
		const path = await storagePath(repo, changeset, io.env, true);
		let harness = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review, changeset);
		try {
			const imported = ExternalFinding.importFile(
				{
					reviewer: { name: "claude-code" },
					findings: [{ ref: "controls", file: "a.ts", line: 1, title: hostile, body: hostile }],
				},
				"controls.json",
			);
			await harness.importFindings(
				{ ...revision, round: "unattributed" },
				[{ source: `file:${hostile}`, imported }],
				"2026-10-27T00:00:00Z",
			);
		} finally {
			await harness.close();
		}
		const storage = await openSqliteStorage(path);
		let expected: StoredComparison;
		try {
			expected = (await ComparisonReader.open(storage).read(changeset))[0]!.comparison.toJSON();
		} finally {
			await storage.close(context);
		}
		const readExport = async (json: boolean) => {
			vi.mocked(io.stdout).mockClear();
			const file = join(repo, json ? "controls.json" : "controls.md");
			expect(
				await main(
					[
						"compare",
						"export",
						"#7",
						...(json ? ["--json"] : []),
						...(destination === "file" ? ["--out", file] : []),
					],
					io,
				),
			).toBe(0);
			return destination === "file" ? readFileSync(file, "utf8") : output();
		};
		const safeLines = (text: string) => {
			for (const line of text.split("\n")) for (const control of controls) expect(line).not.toContain(control);
		};
		const before = await readExport(true);
		safeLines(before);
		expect(JSON.parse(before).unattributed[key]).toStrictEqual(expected!);
		expect(before).toContain('  "unattributed": {');
		expect(before.endsWith("\n")).toBe(true);
		expect(await main(["compare", "#7"], io)).toBe(0);
		const afterFirstSnapshot = await readExport(true);
		safeLines(afterFirstSnapshot);
		expect(JSON.parse(afterFirstSnapshot).unattributed[key]).toStrictEqual(expected!);

		const metadataStorage = await openSqliteStorage(path);
		harness = await CompareHarness.open(metadataStorage, createFakeModels().review, changeset);
		let history: PullRequestRoundHistory;
		try {
			history = await MembershipReader.open(metadataStorage).history();
			const answer = history.current()!.answer;
			const member = {
				id: `${changeset}.r1`,
				base: revision.base,
				head: revision.head,
				status: "member" as const,
				reason: hostile,
			};
			await harness.refreshMembership(answer, [member], "", "2026-10-27T01:00:00Z");
			await harness.refreshMembership(
				answer,
				[{ ...member, status: "foreign" }],
				hostile,
				"2026-10-27T02:00:00Z",
				true,
			);
			history = await MembershipReader.open(metadataStorage).history();
		} finally {
			await harness.close();
		}
		const final = await readExport(true);
		safeLines(final);
		const parsed = JSON.parse(final);
		expect(parsed.unattributed[key]).toStrictEqual(expected!);
		expect(parsed.membership).toStrictEqual(history!.current());
		expect(parsed.history).toStrictEqual(history!.versions);
		expect(final).toContain('  "membership": {');
		expect(final.endsWith("\n")).toBe(true);
		safeLines(await readExport(false));
	},
);
