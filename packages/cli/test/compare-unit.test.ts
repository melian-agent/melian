import * as fs from "node:fs";
import { Changeset, Comparison, ComparisonError } from "@melian-agent/core";
import { buildGoldenRepository, loadGoldens } from "@melian-agent/evals";
import { CompareHarness, createMemoryStorage, FileImporter } from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Io, StoredReview } from "../src/commands.ts";
import { compare, matchByHand, parseImportSource } from "../src/compare.ts";
import * as repository from "../src/repository.ts";
import { CliError } from "../src/repository.ts";

vi.mock("node:fs", { spy: true });

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
