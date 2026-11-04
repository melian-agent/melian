import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	Adjudication,
	defaultConfig,
	ExternalFinding,
	type PullRequestRoundHeads,
	pullRequestChangesetId,
	type RoundMembership,
	type StoredComparison,
} from "@melian-agent/core";
import {
	CompareHarness,
	ComparisonReader,
	backgroundContext as context,
	openSqliteStorage,
	type PullRequestRoundSnapshot,
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

const changeset = pullRequestChangesetId("github", { owner: "owner", name: "repo" }, 7);
const at = "2026-10-26T00:00:00Z";
const answer: PullRequestRoundHeads = {
	repository: { owner: "owner", name: "repo" },
	number: 7,
	base: "a".repeat(40),
	head: "b".repeat(40),
	merge: null,
	commits: ["b".repeat(40)],
	forcePushes: [],
	associated: {},
};
const ownership = { repository: answer.repository, pullRequest: answer.number };
const other = pullRequestChangesetId("github", answer.repository, 8);
const otherCandidate = {
	id: `${other}.r1`,
	base: answer.base,
	head: "d".repeat(40),
	mintedAt: at,
};
const member: RoundMembership = {
	id: `${changeset}.r1`,
	base: answer.base,
	head: answer.head,
	mintedAt: at,
	status: "member",
	reason: "exact pull request merge base",
};
const unnamed: RoundMembership = {
	...member,
	id: `${changeset}.r2`,
	head: "c".repeat(40),
	status: "unattributed",
	reason: "GitHub no longer names this head",
};
const verdict = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
	.adjudicate()
	.toJSON();
const stats = `Comparisons: 1. Pending matches: 0.
codex: recall 1/1 (1.000), precision 1/1 (1.000), pending 0.
melian: recall 0/1 (0.000), precision 0/0 (1.000), pending 0.
owned-missed: 1.
no-owner: 0.
needs-execution: 0.
out-of-scope: 0.
Valid misses without a reason: 0.
Drain not due; next comparison threshold: 3.
Unattributed pull request rounds: 1.
`;
let repo: string;
let io: Io;
let path: string;
let external: string;
let comparison: StoredComparison;
let snapshots: PullRequestRoundSnapshot[];

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "-q", "-b", "main");
	io = {
		cwd: repo,
		env: { MELIAN_TEST_SCRIPT: "unused.json", MELIAN_STATE_DIR: join(repo, "state") },
		color: false,
		stdout: vi.fn(),
		stderr: vi.fn(),
	};
	path = await storagePath(repo, changeset, io.env, true);
	const harness = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review, changeset);
	try {
		const root = await harness.harness.root(context);
		await root.commit(async (tx) => {
			const rounds = await tx.doc(RoundsDocument, root.id);
			rounds.items.r1 = { base: answer.base, head: answer.head, mintedAt: at, tasks: [], verdict };
			rounds.items.r2 = { base: answer.base, head: unnamed.head, mintedAt: at, tasks: [] };
		}, context);
		const revision = { base: answer.base, head: answer.head, round: member.id, target: "saved-range" };
		const imported = await harness.importFindings(
			revision,
			[
				{
					source: "file:codex.json",
					imported: ExternalFinding.importFile(
						{
							reviewer: { name: "codex" },
							findings: [{ ref: "miss", file: "a.ts", line: 1, title: "Missed bug", body: "b" }],
						},
						"codex.json",
					),
				},
			],
			at,
		);
		external = Object.keys(imported.toJSON().external)[0]!;
		comparison = (
			await harness.adjudicate(revision, external, {
				verdict: "valid",
				severity: "P2",
				reason: "owned-missed",
				golden: "correctness",
				by: "Melian Test",
				at,
			})
		).toJSON();
		snapshots = [
			await harness.refreshMembership(answer, [member, unnamed], "Melian Test", at),
			await harness.refreshMembership(answer, [member, unnamed], "Melian Test", "2026-10-26T01:00:00Z"),
		];
	} finally {
		await harness.close();
	}
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
async function writeUnsupported(
	kind: "publisher" | "snapshot" | "comparison",
	newer = true,
	store = { path, changeset },
) {
	const definition = {
		publisher: PublisherDocument.definition,
		snapshot: PullRequestRoundsDocument.definition,
		comparison: ComparisonDocument.definition,
	}[kind];
	const harness = await CompareHarness.open(
		await openSqliteStorage(store.path),
		createFakeModels().review,
		store.changeset,
	);
	try {
		const root = await harness.harness.root(context);
		const marker = defineDoc({
			kind: definition.kind,
			version: definition.version + (newer ? 1 : 0),
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ unsupportedTestMarker: true, comparisons: null }),
			migrate: () => ({ unsupportedTestMarker: true, comparisons: null }),
		});
		await root.commit(async (tx) => {
			const value = await tx.doc(marker, root.id);
			value.unsupportedTestMarker = true;
			value.comparisons = null;
		}, context);
	} finally {
		await harness.close();
	}
}
async function seedOtherPullRequest() {
	const store = { path: await storagePath(repo, other, io.env, true), changeset: other };
	const harness = await CompareHarness.open(await openSqliteStorage(store.path), createFakeModels().review, other);
	try {
		const root = await harness.harness.root(context);
		await root.commit(async (tx) => {
			const rounds = await tx.doc(RoundsDocument, root.id);
			rounds.items.r1 = { base: otherCandidate.base, head: otherCandidate.head, mintedAt: at, tasks: [] };
		}, context);
	} finally {
		await harness.close();
	}
	await writeUnsupported("snapshot", true, store);
}
async function expectComparisonReadable() {
	const storage = await openSqliteStorage(path);
	try {
		expect(
			(await ComparisonReader.open(storage).read(changeset)).map((entry) => ({
				...entry,
				comparison: entry.comparison.toJSON(),
			})),
		).toEqual([{ changeset, round: member.id, comparison, verdict }]);
	} finally {
		await storage.close(context);
	}
}

it.each(["stats", "backlog"])("%s ignores an unrelated future publisher envelope", async (command) => {
	await writeUnsupported("publisher");
	await expectComparisonReadable();
	expect(await main(["compare", command], io), errors()).toBe(0);
	expect(errors()).toBe("");
	if (command === "stats") expect(output()).toBe(stats);
	else expect(output()).toBe(`correctness: saved-range ${external} Missed bug (valid).\n`);
});
it("backlog ignores an unrelated future snapshot envelope", async () => {
	await writeUnsupported("snapshot");
	await expectComparisonReadable();
	expect(await main(["compare", "backlog"], io), errors()).toBe(0);
	expect({ output: output(), errors: errors() }).toEqual({
		output: `correctness: saved-range ${external} Missed bug (valid).\n`,
		errors: "",
	});
});
it("stats refuses the future snapshot it needs", async () => {
	await writeUnsupported("snapshot");
	await expectComparisonReadable();
	expect(await main(["compare", "stats"], io)).toBe(1);
	expect({ output: output(), errors: errors() }).toEqual({
		output: "",
		errors: `melian: melian.pull-request-rounds has newer version ${PullRequestRoundsDocument.definition.version + 1}\n`,
	});
});
it.each(["stats", "backlog"])("%s refuses a future comparison envelope", async (command) => {
	await writeUnsupported("comparison");
	expect(await main(["compare", command], io)).toBe(1);
	expect({ output: output(), errors: errors() }).toEqual({
		output: "",
		errors: `melian: comparison document has newer version ${ComparisonDocument.definition.version + 1}\n`,
	});
});
it.each(["stats", "backlog"])("%s refuses a corrupt comparison", async (command) => {
	await writeUnsupported("comparison", false);
	expect(await main(["compare", command], io)).toBe(1);
	expect(output()).toBe("");
	expect(errors()).toBe("melian: Cannot convert undefined or null to object\n");
});
it("stats counts a nonzero saved unattributed round offline", async () => {
	expect(await main(["compare", "stats"], io), errors()).toBe(0);
	expect({ output: output(), errors: errors() }).toEqual({ output: stats, errors: "" });
});
it("backlog retains the exact owed golden", async () => {
	expect(await main(["compare", "backlog"], io)).toBe(0);
	expect({ output: output(), errors: errors() }).toEqual({
		output: `correctness: saved-range ${external} Missed bug (valid).\n`,
		errors: "",
	});
});
it("an entry-only scan defaults to neither candidates nor histories", async () => {
	await writeUnsupported("snapshot");
	const stores = await ComparisonStores.read(io);
	expect(stores.candidates).toEqual([]);
	expect([...stores.histories]).toEqual([]);
	expect(stores.entries.map((entry) => ({ ...entry, comparison: entry.comparison.toJSON() }))).toEqual([
		{ changeset, round: member.id, comparison, verdict },
	]);
});
it("ownership requests all candidates and its own saved history by default", async () => {
	const stores = await ComparisonStores.read(io, ownership);
	expect(stores.candidates).toEqual(
		[member, unnamed].map(({ id, base, head, mintedAt }) => ({ id, base, head, mintedAt })),
	);
	expect([...stores.histories].map(([id, history]) => [id, history.versions])).toEqual([[changeset, snapshots]]);
	expect(stores.entries.map((entry) => ({ ...entry, comparison: entry.comparison.toJSON() }))).toEqual([
		{ changeset, round: member.id, comparison, verdict },
	]);
});
it("explicit false skips histories while retaining ownership candidates", async () => {
	await writeUnsupported("snapshot");
	const stores = await ComparisonStores.read(io, ownership, false);
	expect(stores.candidates).toEqual(
		[member, unnamed].map(({ id, base, head, mintedAt }) => ({ id, base, head, mintedAt })),
	);
	expect([...stores.histories]).toEqual([]);
	expect(stores.entries.map((entry) => ({ ...entry, comparison: entry.comparison.toJSON() }))).toEqual([
		{ changeset, round: member.id, comparison, verdict },
	]);
});
it("ownership reads only its own saved history beside another pull request's future snapshot", async () => {
	await seedOtherPullRequest();
	const stores = await ComparisonStores.read(io, ownership);
	expect(stores.candidates).toEqual(
		[...[member, unnamed].map(({ id, base, head, mintedAt }) => ({ id, base, head, mintedAt })), otherCandidate].sort(
			(a, b) => a.id.localeCompare(b.id),
		),
	);
	expect([...stores.histories].map(([id, history]) => [id, history.versions])).toEqual([[changeset, snapshots]]);
	expect(stores.entries.map((entry) => ({ ...entry, comparison: entry.comparison.toJSON() }))).toEqual([
		{ changeset, round: member.id, comparison, verdict },
	]);
});
it("stats still refuses another pull request's future snapshot", async () => {
	await seedOtherPullRequest();
	expect(await main(["compare", "stats"], io)).toBe(1);
	expect({ output: output(), errors: errors() }).toEqual({
		output: "",
		errors: `melian: melian.pull-request-rounds has newer version ${PullRequestRoundsDocument.definition.version + 1}\n`,
	});
});
it.each(["publisher", "snapshot"] as const)("ownership still refuses a future %s envelope", async (kind) => {
	await writeUnsupported(kind);
	await expectComparisonReadable();
	await expect(ComparisonStores.read(io, ownership)).rejects.toThrow(
		kind === "publisher" ? "melian.publisher has newer version" : "melian.pull-request-rounds has newer version",
	);
});
