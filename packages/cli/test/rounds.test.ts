import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Finding, loadConfig, pullRequestChangesetId, ReviewPlan } from "@melian-agent/core";
import {
	CompareHarness,
	backgroundContext as context,
	createReviewRegistry,
	openHarness,
	openSqliteStorage,
	RoundReader,
	reviewChangeset,
	revisionKey,
	upsertFinding,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewIndex } from "../../pipeline/src/review-index.ts";
import { RoundsDocument, RoundWriter } from "../../pipeline/src/rounds.ts";
import { baseAndHead, gitIn } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import * as repository from "../src/repository.ts";
import { storagePath } from "../src/repository.ts";

let repo: string;
let dir: string;
let changeset: Changeset;
let io: Io & {
	stdout: ReturnType<typeof vi.fn<(text: string) => void>>;
	stderr: ReturnType<typeof vi.fn<(text: string) => void>>;
};
beforeEach(async () => {
	repo = baseAndHead({ "a.ts": "export const n = 1;\n" }, { "a.ts": "export const n = 2;\n" });
	dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-round-cli-")));
	changeset = await Changeset.resolve(repo, "main...feature");
	io = {
		cwd: repo,
		env: { MELIAN_STATE_DIR: dir, XDG_CONFIG_HOME: join(dir, "config"), PI_CODING_AGENT_DIR: join(dir, "pi") },
		color: false,
		stdout: vi.fn<(text: string) => void>(),
		stderr: vi.fn<(text: string) => void>(),
	};
	const fake = createFakeModels();
	const harness = await openHarness(await openSqliteStorage(await storagePath(repo, changeset.id, io.env, false)), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	try {
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		await root.commit(
			(tx) =>
				upsertFinding(
					tx,
					root.id,
					Finding.create({
						rule: "null-dereference",
						message: "n is wrong",
						file: "a.ts",
						startLine: 1,
						snippet: "export const n = 2;",
						occurrence: 0,
						cause: "introduced",
						severity: "P1",
						explanation: { what: "wrong", whyHere: "here", whatToDo: "fix" },
						source: { check: "static.mutation", version: "1" },
					}),
					revisionKey(changeset.revision),
				),
			context,
		);
		await root.commit(
			(tx) =>
				upsertFinding(
					tx,
					root.id,
					Finding.create({
						rule: "minor-note",
						message: "small",
						file: "a.ts",
						startLine: 1,
						snippet: "export const n = 2;",
						occurrence: 0,
						cause: "introduced",
						severity: "nit",
						explanation: { what: "small", whyHere: "here", whatToDo: "fix" },
						source: { check: "static.mutation", version: "1" },
					}),
					revisionKey(changeset.revision),
				),
			context,
		);
		await reviewChangeset({
			harness,
			changeset,
			config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
			lenses: [],
			standards: [],
			models: fake.review,
			checks: [{ name: "static.mutation", status: "ran" }],
		});
	} finally {
		await harness.close(context);
	}
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(repo, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});

it("keeps r1's passing verdict after r2 blocks the same revision", async () => {
	io = { ...io, env: { ...io.env, MELIAN_STATE_DIR: join(dir, "history") } };
	const path = await storagePath(repo, changeset.id, io.env, false);
	const fake = createFakeModels();
	const harness = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	try {
		const root = await harness.root(context, { agent: { model: fake.ref() } });
		const options = {
			harness,
			changeset,
			config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
			lenses: [],
			standards: [],
			models: fake.review,
			checks: [{ name: "static.mutation", status: "ran" as const }],
		};
		expect((await reviewChangeset(options)).verdict).toMatchObject({ status: "passed", blocking: false });
		await root.commit(
			(tx) =>
				upsertFinding(
					tx,
					root.id,
					Finding.create({
						rule: "null-dereference",
						message: "n is wrong",
						file: "a.ts",
						startLine: 1,
						snippet: "export const n = 2;",
						occurrence: 0,
						cause: "introduced",
						severity: "P1",
						explanation: { what: "wrong", whyHere: "here", whatToDo: "fix" },
						source: { check: "static.mutation", version: "1" },
					}),
					revisionKey(changeset.revision),
				),
			context,
		);
		expect((await reviewChangeset(options)).verdict).toMatchObject({ status: "findings", blocking: true });
	} finally {
		await harness.close(context);
	}
	const storage = await openSqliteStorage(path);
	try {
		const rounds = await new RoundReader(storage).read(changeset.id, context);
		expect(rounds.map((round) => ({ id: round.id, base: round.stored.base, head: round.stored.head }))).toEqual([
			{ id: `${changeset.id}.r1`, base: changeset.revision.base, head: changeset.revision.head },
			{ id: `${changeset.id}.r2`, base: changeset.revision.base, head: changeset.revision.head },
		]);
		expect.soft(rounds[0]!.verdict()).toMatchObject({ status: "passed", blocking: false });
		expect(rounds[1]!.verdict()).toMatchObject({ status: "findings", blocking: true });
	} finally {
		await storage.close(context);
	}
	expect(await main(["findings", "--round", `${changeset.id}.r1`, "--json"], io)).toBe(0);
	expect.soft(JSON.parse(io.stdout.mock.calls.join(""))).toMatchObject({ status: "passed", blocking: false });
});

it.each([false, true])("lists the range's rounds (json=%s)", async (json) => {
	expect(await main(["findings", "main...feature", "--rounds", ...(json ? ["--json"] : [])], io)).toBe(0);
	const output = io.stdout.mock.calls.map(([text]) => text).join("");
	expect(output).toContain(`${changeset.id}.r1`);
	expect(output).toContain(changeset.revision.head);
	if (json)
		expect(JSON.parse(output)[0]).toMatchObject({
			id: `${changeset.id}.r1`,
			base: changeset.revision.base,
		});
});

it("lists main's legacy round before a minted undecided round and asks git for its head date", async () => {
	const path = await storagePath(repo, changeset.id, io.env, false);
	copyFileSync(new URL("../../pipeline/test/fixtures/rounds-main/decided.sqlite", import.meta.url), path);
	gitIn(
		repo,
		"fetch",
		new URL("../../pipeline/test/fixtures/rounds-main/repo.bundle", import.meta.url).pathname,
		"refs/heads/main:refs/heads/legacy-base",
		"refs/heads/feature:refs/heads/legacy-head",
	);
	const oldHead = gitIn(repo, "rev-parse", "legacy-head");
	const fake = createFakeModels();
	const harness = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	const root = await harness.root(context);
	await root.commit(
		(tx) => new RoundWriter(tx, root.id).mint(revisionKey(changeset.revision), 999, "2020-01-01T00:00:00Z"),
		context,
	);
	await harness.close(context);
	const git = vi.spyOn(repository, "git");
	expect(await main(["findings", "main...feature", "--rounds", "--json"], io)).toBe(0);
	const output = JSON.parse(io.stdout.mock.calls.join(""));
	expect(output).toHaveLength(2);
	expect(output[0].id).toMatch(/\.k[0-9a-f]{16}$/);
	expect(output[0].date).toBe(
		new Date(Number(gitIn(repo, "show", "-s", "--format=%ct", oldHead, "--")) * 1000).toISOString(),
	);
	expect(output[1]).toMatchObject({ id: `${changeset.id}.r1`, status: "undecided" });
	expect(git).toHaveBeenCalledWith(repo, ["show", "-s", "--format=%ct", oldHead, "--"]);
	io.stdout.mockClear();
	expect(await main(["findings", "--round", output[0].id, "--json"], io)).toBe(0);
	expect(JSON.parse(io.stdout.mock.calls.join("")).status).toBe("passed");
	io.stdout.mockClear();
	expect(await main(["compare", "main...feature", "--round", output[0].id], io)).toBe(0);
});

it("reads a round from pull-request storage by its full ID", async () => {
	const repository = { owner: "example", name: "melian" };
	const id = pullRequestChangesetId("github", repository, 12);
	const fake = createFakeModels();
	const harness = await openHarness(await openSqliteStorage(await storagePath(repo, id, io.env, false)), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	try {
		await harness.root(context, { agent: { model: fake.ref() } });
		await reviewChangeset({
			harness,
			changeset: changeset.withId(id),
			config: { ...defaultConfig, tiers: { full: [] } },
			lenses: [],
			standards: [],
			models: fake.review,
			checks: [],
			origin: {
				kind: "pull-request",
				repository,
				pullRequest: 12,
				base: changeset.revision.base,
				head: changeset.revision.head,
			},
		});
	} finally {
		await harness.close(context);
	}
	expect(await main(["findings", "--round", `${id}.r1`, "--json"], io)).toBe(0);
	expect(JSON.parse(io.stdout.mock.calls.join("")).status).toBe("passed");
	io.stdout.mockClear();
	expect(await main(["compare", "main...feature", "--round", `${id}.r1`], io)).toBe(0);
});

it.each([[], ["--json"], ["--open"], ["--open", "--json"], ["--all"]].map((flags) => ({ flags })))(
	"reads a frozen round independently of range refs with $flags",
	async ({ flags }) => {
		gitIn(repo, "branch", "-D", "main");
		expect(await main(["findings", "--round", `${changeset.id}.r1`, ...flags], io)).toBe(0);
		const output = io.stdout.mock.calls.map(([text]) => text).join("");
		expect(output).toContain("null-dereference");
		if (flags.includes("--json")) {
			const json = JSON.parse(output);
			if (flags.includes("--open")) expect(json.runs[0].results).toHaveLength(1);
			else expect(json.status).toBe("findings");
		} else if (flags.includes("--all")) expect(output).toContain("minor-note");
		else expect(output).not.toContain("minor-note");
		expect(io.stderr).not.toHaveBeenCalled();
	},
);

it.each([false, true])("keeps agent instructions in current text findings (open=%s)", async (open) => {
	expect(await main(["findings", "main...feature", ...(open ? ["--open"] : [])], io)).toBe(0);
	const text = io.stdout.mock.calls.map(([text]) => text).join("");
	expect(text).toContain("Check each open finding against the code.");
	expect(text).toContain("<quoted-");
	expect(text).toContain("melian dismiss 'main...feature'");
});

it.each([false, true])("prints the round's stored plan warnings only in text (json=%s)", async (json) => {
	const fake = createFakeModels();
	const harness = await openHarness(await openSqliteStorage(await storagePath(repo, changeset.id, io.env, false)), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	const root = await harness.root(context);
	const plan = ReviewPlan.resolve({
		config: defaultConfig,
		routes: (await loadConfig(repo, { kind: "worktree" }, ".")).routes,
		model: "test/changed",
		checks: [],
		lenses: [],
		catalog: [],
		credentials: {},
	});
	expect(plan.summary()).not.toBe("");
	await root.commit(async (tx) => {
		(await tx.doc(RoundsDocument, root.id)).items.r1!.provenance!.plan = plan.toJSON();
	}, context);
	await harness.close(context);
	expect(await main(["findings", "--round", `${changeset.id}.r1`, ...(json ? ["--json"] : [])], io)).toBe(0);
	if (json) expect(io.stderr).not.toHaveBeenCalled();
	else expect(io.stderr.mock.calls.join("")).toContain("melian:");
});

it.each([
	"../outside.r1",
	"range-0123456789abcdef.r0",
	"range-0123456789abcdef.r01",
	"range-0123456789abcdef.kabc",
	"range-0123456789abcdef0.r1",
	"pull-0123456789abcdef0.r1",
	"range-0123456789abcdef.k0123456789abcdef0",
	"range-0123456789abcdef.r1/../../outside",
])("refuses an invalid round ID %s", async (id) => {
	for (const command of [["findings"], ["compare", "main...feature"]]) {
		io.stderr.mockClear();
		expect(await main([...command, "--round", id], io)).toBe(1);
		expect(io.stderr.mock.calls.join("")).toContain("invalid round ID");
	}
});

it.each(
	[
		["--rounds", "--open"],
		["--rounds", "--all"],
		["--rounds", "--round", "id"],
		["--round", "id"],
	].map((flags) => ({ flags })),
)("refuses conflicting range options $flags", async ({ flags }) => {
	expect(await main(["findings", "main...feature", ...flags], io)).toBe(64);
});

it("opens only the chosen state directory", async () => {
	const elsewhere = { ...io, env: { ...io.env, MELIAN_STATE_DIR: join(dir, "elsewhere") } };
	expect(await main(["findings", "--round", `${changeset.id}.r1`], elsewhere)).toBe(1);
	expect(io.stderr.mock.calls.join("")).toContain("has no round");
});

it("refuses a standalone round ID combined with a listing", async () => {
	expect(await main(["findings", "--round", `${changeset.id}.r1`, "--rounds"], io)).toBe(64);
});

it.each(["rounds", "no-rounds"])(
	"confines --%s to findings without writing a comparison",
	async (option) => {
		const flags = [`--${option}`];
		expect(await main(["compare", "main...feature", ...flags], io)).toBe(64);
		expect(io.stdout).not.toHaveBeenCalled();
		expect(await main(["compare", "export", "main...feature", "--json"], io)).toBe(1);
		expect(await main(["compare", "main...feature"], io)).toBe(0);
	},
	60_000,
);

it("keeps ordinary findings when --no-rounds is supplied", async () => {
	expect(await main(["findings", "main...feature", "--no-rounds", "--json"], io)).toBe(0);
	expect(JSON.parse(io.stdout.mock.calls.join("")).status).toBe("findings");
});

it("refuses missing and undecided rounds even when an earlier frozen verdict exists", async () => {
	const path = await storagePath(repo, changeset.id, io.env, false);
	const fake = createFakeModels();
	const harness = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	const root = await harness.root(context);
	await root.commit(async (tx) => {
		await new RoundWriter(tx, root.id).mint(revisionKey(changeset.revision), 999, "2026-10-18T00:00:00Z");
		delete (await tx.doc(ReviewIndex, root.id)).reviews[revisionKey(changeset.revision)];
	}, context);
	await harness.close(context);
	for (const [suffix, message] of [
		["r2", "has no decided round"],
		["k0123456789abcdef", "has no round"],
		["r3", "has no round"],
	]) {
		io.stderr.mockClear();
		const id = `${changeset.id}.${suffix}`;
		expect(await main(["findings", "--round", id], io)).toBe(1);
		expect(io.stderr.mock.calls.join("")).toContain(`Melian ${message} ${id}`);
	}
	expect(await main(["findings", "--round", `${changeset.id}.r1`], io)).toBe(0);
});

it.each([false, true])("lists an unreadable legacy head last with an unknown date (json=%s)", async (json) => {
	const path = await storagePath(repo, changeset.id, io.env, false);
	copyFileSync(new URL("../../pipeline/test/fixtures/rounds-main/decided.sqlite", import.meta.url), path);
	const fake = createFakeModels();
	const harness = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	try {
		const root = await harness.root(context);
		await root.commit(
			(tx) => new RoundWriter(tx, root.id).mint(revisionKey(changeset.revision), 999, "2020-01-01T00:00:00Z"),
			context,
		);
	} finally {
		await harness.close(context);
	}
	expect(await main(["findings", "main...feature", "--rounds", ...(json ? ["--json"] : [])], io)).toBe(0);
	const output = io.stdout.mock.calls.join("");
	if (json) {
		const listed = JSON.parse(output);
		expect(listed).toHaveLength(2);
		expect(listed[0]).toMatchObject({ id: `${changeset.id}.r1`, date: "2020-01-01T00:00:00Z" });
		expect(listed[1]).toMatchObject({
			id: expect.stringMatching(/\.k[0-9a-f]{16}$/),
			date: "unknown",
			status: "passed",
		});
	} else {
		const rows = output.trim().split("\n");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain(`${changeset.id}.r1`);
		expect(rows[0]).toContain("2020-01-01T00:00:00Z");
		expect(rows[1]).toMatch(/\.k[0-9a-f]{16} .*unknown/);
	}
	expect(io.stderr).not.toHaveBeenCalled();
});

it.each(["import", "match", "unmatch", "adjudicate"])(
	"routes comparison %s to an explicit round after the branch is deleted",
	async (operation) => {
		const path = await storagePath(repo, changeset.id, io.env, false);
		const compare = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review, changeset.id);
		let id: string;
		try {
			const comparison = await compare.importFindings(changeset.revision, [], "2026-10-21T00:00:00Z");
			id = comparison.melianFindings()[0]!;
		} finally {
			await compare.close();
		}
		const externalFile = join(dir, "review.json");
		writeFileSync(
			externalFile,
			JSON.stringify({
				reviewer: { name: "codex" },
				findings: [{ file: "a.ts", line: 999, title: "n is wrong", body: "wrong" }],
			}),
		);
		const selected = ["--round", `${changeset.id}.r1`];
		expect(await main(["compare", "main...feature", "--from", `file:${externalFile}`, ...selected], io)).toBe(0);
		io.stdout.mockClear();
		expect(await main(["compare", "export", "main...feature", "--json"], io)).toBe(0);
		const exported = JSON.parse(io.stdout.mock.calls.join(""));
		const external = Object.keys(exported.comparisons[`${changeset.id}.r1`].external)[0]!;
		const pending = await CompareHarness.open(await openSqliteStorage(path), createFakeModels().review, changeset.id);
		try {
			const root = await pending.harness.root(context);
			await root.commit(
				(tx) => new RoundWriter(tx, root.id).mint(revisionKey(changeset.revision), 999, "later"),
				context,
			);
		} finally {
			await pending.close();
		}

		gitIn(repo, "checkout", "--quiet", "main");
		gitIn(repo, "branch", "-D", "feature");
		io.stdout.mockClear();
		const args =
			operation === "import"
				? ["compare", "main...feature", "--from", `file:${externalFile}`]
				: operation === "adjudicate"
					? ["compare", "adjudicate", "main...feature", id!, "--verdict", "noise"]
					: ["compare", operation, "main...feature", external, id!];
		expect(await main([...args, ...selected], io)).toBe(0);
		expect(io.stderr.mock.calls).toEqual([]);
		if (operation === "import" || operation === "unmatch")
			expect(io.stdout.mock.calls.join("")).toContain("null-dereference");
		const reopened = await CompareHarness.open(
			await openSqliteStorage(path),
			createFakeModels().review,
			changeset.id,
		);
		try {
			const comparison = (await reopened.read({ ...changeset.revision, round: `${changeset.id}.r1` }))!;
			if (operation === "import") expect(comparison.externalFindings()).toHaveLength(1);
			if (operation === "match")
				expect(comparison.effectiveMatches()).toContainEqual(
					expect.objectContaining({ kind: "hand", external, melian: id! }),
				);
			if (operation === "unmatch") expect(comparison.effectiveMatches()).toEqual([]);
			if (operation === "adjudicate") expect(comparison.adjudication(id!)?.current.verdict).toBe("noise");
		} finally {
			await reopened.close();
		}
	},
);

it.each(["bad", "range-ffffffffffffffff.r1", "missing"])(
	"refuses comparison round %s without creating storage",
	async (argument) => {
		const id = argument === "missing" ? `${changeset.id}.r9` : argument;
		expect(await main(["compare", "main...feature", "--round", id], io)).toBe(1);
		expect(io.stderr.mock.calls.join("")).toContain(argument === "bad" ? "invalid round ID" : "has no round");
		if (argument === "range-ffffffffffffffff.r1")
			expect(existsSync(await storagePath(repo, "range-ffffffffffffffff", io.env, false))).toBe(false);
		expect(io.stdout).not.toHaveBeenCalled();
	},
);

it("comparison writes search only the selected state directory", async () => {
	const elsewhere = { ...io, env: { ...io.env, MELIAN_STATE_DIR: join(dir, "elsewhere") } };
	expect(await main(["compare", "main...feature", "--round", `${changeset.id}.r1`], elsewhere)).toBe(1);
	expect(io.stderr.mock.calls.join("")).toContain("has no round");
});

it.each([
	["compare", "export", "main...feature"],
	["compare", "stats"],
	["compare", "backlog"],
	["compare", "#7"],
	["review", "main...feature"],
])("refuses --round outside range writes: %s", async (...args) => {
	expect(await main([...args, "--round", `${changeset.id}.r1`], io)).toBe(64);
});
