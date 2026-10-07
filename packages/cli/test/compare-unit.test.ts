import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { Changeset, Comparison, ComparisonError, Lens, LensError } from "@melian-agent/core";
import { buildGoldenRepository, loadGoldens } from "@melian-agent/evals";
import { CompareHarness, ComparisonReader, createMemoryStorage, FileImporter } from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Io, StoredReview } from "../src/commands.ts";
import {
	adjudicateComparison,
	compare,
	comparisonBacklog,
	comparisonStats,
	exportComparison,
	matchByHand,
	parseImportSource,
} from "../src/compare.ts";
import * as repository from "../src/repository.ts";
import { CliError } from "../src/repository.ts";

vi.mock("node:fs", { spy: true });
vi.mock("node:fs/promises", { spy: true });

let io: Io;
let repo: string;
let harness: CompareHarness;
let missing: CliError;

beforeEach(async () => {
	vi.mocked(fs.existsSync).mockReset();
	const golden = loadGoldens().find((each) => each.name === "correctness-null-deref")!;
	({ repo } = buildGoldenRepository(golden));
	const changeset = await Changeset.resolve(repo, "main...feature");
	io = { cwd: repo, env: { MELIAN_TEST_SCRIPT: "unused.json" }, color: false, stdout: vi.fn(), stderr: vi.fn() };
	missing = new CliError("missing review");
	vi.spyOn(StoredReview, "open").mockResolvedValue({ changeset, argument: "main...feature", missing: () => missing });
	vi.spyOn(repository, "git").mockResolvedValue("Melian Test <test@melian.invalid> 0 +0000");
	vi.spyOn(repository, "storagePath").mockResolvedValue("recorded.sqlite");
	vi.spyOn(fs, "existsSync").mockReturnValue(true);
	const storage = createMemoryStorage();
	vi.spyOn(repository, "openStorage").mockResolvedValue(storage);
	harness = await CompareHarness.open(storage, createFakeModels().review);
	vi.spyOn(CompareHarness, "open").mockResolvedValue(harness);
	vi.spyOn(harness, "reviewed").mockResolvedValue(true);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await harness.close();
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("comparison command failures", () => {
	it("refuses missing storage before opening a harness", async () => {
		vi.spyOn(fs, "existsSync").mockReturnValue(false);

		await expect(compare(io, "main...feature", [])).rejects.toBe(missing);
		expect(CompareHarness.open).not.toHaveBeenCalled();
	});

	it("closes the harness when checking the stored review fails", async () => {
		const failure = new Error("cannot read verdict");
		vi.spyOn(harness, "reviewed").mockRejectedValue(failure);
		const close = vi.spyOn(harness, "close");

		await expect(compare(io, "main...feature", [])).rejects.toBe(failure);
		expect(close).toHaveBeenCalledExactlyOnceWith(expect.anything());
	});

	it("closes the harness when storage holds no review of the revision", async () => {
		vi.spyOn(harness, "reviewed").mockResolvedValue(false);
		const close = vi.spyOn(harness, "close");

		await expect(compare(io, "main...feature", [])).rejects.toBe(missing);
		expect(close).toHaveBeenCalledExactlyOnceWith(expect.anything());
	});

	it("refuses GitHub on a range and closes the harness", async () => {
		const close = vi.spyOn(harness, "close");

		await expect(compare(io, "main...feature", [{ kind: "github", login: "octocat" }])).rejects.toMatchObject({
			name: "CliError",
			message: expect.stringContaining('name it as "#12"'),
		});
		expect(close).toHaveBeenCalledExactlyOnceWith(expect.anything());
	});

	it("closes the harness after a successful comparison", async () => {
		const comparison = Comparison.of({ base: "a".repeat(40), head: "b".repeat(40) });
		vi.spyOn(harness, "importFindings").mockResolvedValue(comparison);
		const close = vi.spyOn(harness, "close");

		expect(await compare(io, "main...feature", [])).toBe(0);
		expect(close).toHaveBeenCalledExactlyOnceWith(expect.anything());
	});

	it("prints zero for a source absent from the returned comparison", async () => {
		fs.writeFileSync(`${repo}/empty.json`, JSON.stringify({ reviewer: { name: "human" }, findings: [] }));
		const importer = await FileImporter.open("empty.json", { cwd: repo, repoRoot: repo });
		vi.spyOn(FileImporter, "open").mockResolvedValue(importer);
		vi.spyOn(importer, "import").mockResolvedValue({ findings: [], skippedBodies: 2 });
		vi.spyOn(harness, "importFindings").mockResolvedValue(
			Comparison.of({ base: "a".repeat(40), head: "b".repeat(40) }),
		);

		expect(await compare(io, "main...feature", [{ kind: "file", path: "empty.json" }])).toBe(0);
		expect(io.stdout).toHaveBeenCalledWith(
			"Imported 0 from file:empty.json, skipping 2 review bodies without a thread.\n",
		);
	});

	it.each([true, false])("preserves an unexpected hand-match error and closes the harness: %s", async (matched) => {
		const failure = new Error("write failed");
		vi.spyOn(harness, matched ? "match" : "unmatch").mockRejectedValue(failure);
		const close = vi.spyOn(harness, "close");

		await expect(matchByHand(io, "main...feature", { external: "e", melian: "m" }, matched)).rejects.toBe(failure);
		expect(close).toHaveBeenCalledExactlyOnceWith(expect.anything());
	});

	it("adds listing advice to a comparison hand-match error", async () => {
		vi.spyOn(harness, "match").mockRejectedValue(new ComparisonError("unknownExternal", "unknown finding"));

		await expect(matchByHand(io, "main...feature", { external: "e", melian: "m" }, true)).rejects.toMatchObject({
			name: "CliError",
			message: "unknown finding; melian compare main...feature lists the findings",
		});
	});
});

describe("comparison command guards", () => {
	const stub = (needsReason: boolean, melian: string[] = []) =>
		({ needsReason: () => needsReason, render: () => "", melianFindings: () => melian }) as unknown as Comparison;
	const out = () =>
		vi
			.mocked(io.stdout)
			.mock.calls.map(([text]) => text)
			.join("");
	const pair = { external: "e", melian: "m" };

	it("records the target the user named when importing", async () => {
		const importFindings = vi
			.spyOn(harness, "importFindings")
			.mockResolvedValue(Comparison.of({ base: "a".repeat(40), head: "b".repeat(40) }));
		expect(await compare(io, "main...feature", [])).toBe(0);
		expect(importFindings).toHaveBeenCalledWith(
			expect.objectContaining({ target: "main...feature" }),
			[],
			expect.any(String),
		);
	});

	it.each([
		["an unmatch that leaves a miss owing its reason", false, true, true],
		["an unmatch that owes nothing", false, false, false],
		["a match", true, true, false],
	])("says a finding is pending after %s: %s", async (_name, matched, owes, said) => {
		vi.spyOn(harness, matched ? "match" : "unmatch").mockResolvedValue(stub(owes));
		await matchByHand(io, "main...feature", pair, matched);
		expect(out().includes("Finding e is pending until re-adjudicated with a miss reason.")).toBe(said);
	});

	it("records the target an adjudication was named by", async () => {
		const adjudicate = vi.spyOn(harness, "adjudicate").mockResolvedValue(stub(false));
		await adjudicateComparison(io, "main...feature", "e", { verdict: "noise" });
		expect(adjudicate).toHaveBeenCalledWith(
			expect.objectContaining({ target: "main...feature" }),
			"e",
			expect.objectContaining({ verdict: "noise" }),
		);
	});

	it("warns about lenses it cannot read", async () => {
		vi.spyOn(harness, "adjudicate").mockResolvedValue(stub(false));
		vi.spyOn(Lens, "load").mockRejectedValueOnce(new LensError("unreadable", "lenses/x.md", "broken lens"));
		await adjudicateComparison(io, "main...feature", "e", { verdict: "valid", golden: "correctness" });
		expect(out()).toContain("Warning: could not read lenses: broken lens");
	});

	it("lets a failure other than a lens error through", async () => {
		vi.spyOn(harness, "adjudicate").mockResolvedValue(stub(false));
		const failure = new Error("disk full");
		vi.spyOn(Lens, "load").mockRejectedValueOnce(failure);
		await expect(
			adjudicateComparison(io, "main...feature", "e", { verdict: "valid", golden: "correctness" }),
		).rejects.toBe(failure);
	});

	it.each([
		["noise on a Melian finding", "noise", ["m"], true],
		["noise on an external finding", "noise", [], false],
		["a valid Melian finding", "valid", ["m"], false],
	] as const)("notes that noise does not dismiss only for %s", async (_name, verdict, melian, said) => {
		vi.spyOn(harness, "adjudicate").mockResolvedValue(stub(false, [...melian]));
		await adjudicateComparison(io, "main...feature", "m", { verdict });
		expect(out().includes("This does not dismiss the Melian finding")).toBe(said);
	});
});

describe("stored comparison reading and export", () => {
	const dir = "/state/scripted";
	const names = ["range-bbbbbbbbbbbbbbbb.sqlite", "pull-cccccccccccccccc.sqlite", "range-aaaaaaaaaaaaaaaa.sqlite"];
	const entry = () => {
		const comparison = Comparison.of({ base: "a".repeat(40), head: "b".repeat(40) });
		return { changeset: "c", comparison };
	};

	it("reads comparison databases in name order and no other file", async () => {
		vi.spyOn(repository, "stateDirectory").mockResolvedValue("/state");
		vi.spyOn(fsp, "readdir").mockResolvedValue([
			...names,
			"range-zzzz.sqlite",
			"range-aaaaaaaaaaaaaaaa.sqlite-wal",
			"other.sqlite",
		] as never);
		const read = vi.spyOn(ComparisonReader, "open").mockReturnValue({ read: async () => [] } as never);

		expect(await comparisonStats(io, {})).toBe(0);

		expect(vi.mocked(repository.openStorage).mock.calls.map(([path]) => path)).toEqual(
			[...names].sort().map((name) => join(dir, name)),
		);
		expect(read).toHaveBeenCalledTimes(3);
	});

	it("reads no comparisons from a state directory that does not exist, and refuses an unreadable one", async () => {
		vi.spyOn(repository, "stateDirectory").mockResolvedValue("/state");
		vi.spyOn(fsp, "readdir").mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
		expect(await comparisonBacklog(io, false)).toBe(0);
		expect(io.stdout).toHaveBeenCalledWith("No goldens owed.\n");
		vi.spyOn(fsp, "readdir").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
		await expect(comparisonBacklog(io, false)).rejects.toMatchObject({
			message: `cannot read comparisons at ${dir}: denied`,
		});
	});

	it("refuses to export a changeset with no database, whatever the reader would find", async () => {
		vi.spyOn(fs, "existsSync").mockReturnValue(false);
		vi.spyOn(ComparisonReader, "open").mockReturnValue({ read: async () => [entry()] } as never);
		await expect(exportComparison(io, "main...feature", { json: false })).rejects.toMatchObject({
			message: expect.stringContaining("no comparison recorded"),
		});
	});

	it.each([
		["#7", "git@github.com:o/r.git", "(https://github.com/o/r/pull/7)"],
		["#7", "https://github.com/o/r.git", "(https://github.com/o/r/pull/7)"],
		["#7", "https://github.com/o/r", "(https://github.com/o/r/pull/7)"],
		["#7", "https://gitlab.com/o/r.git", undefined],
		["#7", "https://github.com/o", undefined],
		["#7", new Error("no such remote"), undefined],
		["main...feature", "git@github.com:o/r.git", undefined],
	])("links %s only when it is a pull request", async (argument, remote, link) => {
		if (remote instanceof Error) vi.spyOn(repository, "git").mockRejectedValue(remote);
		else vi.spyOn(repository, "git").mockResolvedValue(remote);
		vi.spyOn(ComparisonReader, "open").mockReturnValue({ read: async () => [entry()] } as never);
		await exportComparison(io, argument, { json: false });
		const text = vi
			.mocked(io.stdout)
			.mock.calls.map(([each]) => each)
			.join("");
		if (link === undefined) expect(text).not.toContain("github.com/o/r/pull");
		else expect(text).toContain(link);
	});

	it("writes --out relative to the working directory", async () => {
		vi.spyOn(ComparisonReader, "open").mockReturnValue({ read: async () => [entry()] } as never);
		const write = vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
		await exportComparison(io, "main...feature", { json: false, out: "record.md" });
		expect(write).toHaveBeenCalledWith(join(repo, "record.md"), expect.any(String), "utf8");
	});
});

describe("import source parsing", () => {
	it.each(["github:", "file:", "gitlab", "file", "githubx"])("refuses %j", (source) => {
		expect(parseImportSource(source)).toBeUndefined();
	});
	it.each([
		["github", { kind: "github", login: "coderabbitai[bot]" }],
		["github:octocat", { kind: "github", login: "octocat" }],
		["file:reviews/claude.json", { kind: "file", path: "reviews/claude.json" }],
	])("parses %j", (source, expected) => {
		expect(parseImportSource(source)).toEqual(expected);
	});
});
