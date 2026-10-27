import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Changeset, MutationInventory, type PullRequest } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commit, createRepository, gitIn, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import * as target from "../src/target.ts";

let repo: string;
let base: string;
let head: string;
beforeEach(() => {
	repo = createRepository();
	base = commit(repo, { "src/a.ts": "export const flag = true;\n" });
	head = commit(repo, { "src/a.ts": "export const flag = false;\n" });
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

function output(): Io & { lines: string[]; errors: string[] } {
	const lines: string[] = [],
		errors: string[] = [];
	return {
		cwd: repo,
		env: {},
		color: false,
		stdout: (text) => lines.push(text),
		stderr: (text) => errors.push(text),
		lines,
		errors,
	};
}

describe("mutants commands", { timeout: 60_000 }, () => {
	it("fetches a pull request and uses its current base policy rather than its merge base", async () => {
		const policy = commit(repo, {
			"stryker.config.json": JSON.stringify({ mutator: { excludedMutations: ["BooleanLiteral"] } }),
		});
		gitIn(repo, "update-ref", "refs/melian/pull/7/base", base);
		gitIn(repo, "update-ref", "refs/melian/pull/7/head", head);
		const changeset = await Changeset.resolve(repo, `${base}..${head}`);
		const pullRequest: PullRequest = {
			repository: { owner: "owner", name: "repo" },
			number: 7,
			title: "Change",
			url: "https://github.com/owner/repo/pull/7",
			state: "open",
			base: { ref: "main", sha: policy },
			head: { ref: "feature", sha: head },
			fetch: { url: "https://github.com/owner/repo.git", headRef: "refs/pull/7/head" },
		};
		const provider = createGitHubProvider({
			owner: "owner",
			repo: "repo",
			token: "test",
			fetch: vi.fn(() => {
				throw new Error("no network expected");
			}),
		});
		vi.spyOn(target, "gitHubFor").mockResolvedValue(provider);
		const fetched = vi.spyOn(target, "fetchedPullRequest").mockResolvedValue({ changeset, pullRequest });
		const io = output();
		expect(await main(["mutants", "list", "#7", "--json"], io)).toBe(0);
		expect(fetched).toHaveBeenCalledWith(repo, provider, 7);
		const data = JSON.parse(io.lines.join(""));
		expect(data.range).toEqual({ base, head, target: pullRequest.url });
		expect(data.mutants).toHaveLength(1);
		expect(data.mutants[0]).toMatchObject({ status: "ignored", ignoredBy: "config" });
	});
	it("lists a versioned inventory and samples structural and legacy claims", async () => {
		const io = output();
		expect(await main(["mutants", "list", `${base}..${head}`, "--json", "--all"], io)).toBe(0);
		expect(MutationInventory.parse(JSON.parse(io.lines.join(""))).toJSON().melianMutants).toBe(2);
		const data = JSON.parse(io.lines.join(""));
		expect(data.mutants).toHaveLength(1);
		expect(data.range).toEqual({ base, head });
		data.mutants[0].claim = "killed";
		data.mutants[0].evidence = { test: { file: "test/a.test.ts", path: ["flags", "works"] } };
		data.mutants[0].survivorClasses = [];
		await writeFile(join(repo, "inventory.json"), JSON.stringify(data));
		io.lines.length = 0;
		expect(await main(["mutants", "sample", "inventory.json"], io)).toBe(0);
		expect(JSON.parse(io.lines.join("")).selected).toEqual([{ ...data.mutants[0], sampleHash: data.mutants[0].id }]);
		const legacy = {
			mutants: [{ ...data.mutants[0], evidence: "a.test.ts > flags works" }],
			total: 1,
			omitted: 0,
			unmutated: [],
		};
		await writeFile(join(repo, "legacy.json"), JSON.stringify(legacy));
		io.lines.length = 0;
		expect(await main(["mutants", "sample", "legacy.json"], io)).toBe(0);
		expect(JSON.parse(io.lines.join("")).selected[0].sampleHash).toBe(data.mutants[0].id);
		expect(io.errors).toEqual([]);
	});

	it("prints full identity coordinates and a truncation count in text", async () => {
		const io = output();
		expect(await main(["mutants", "list", `${base}..${head}`, "--limit", "0"], io)).toBe(0);
		expect(io.lines.join("")).toContain("END_LINE\tEND_COLUMN");
		expect(io.lines.join("")).toContain("0 of 1 mutants; 1 omitted");
	});

	it.each([
		[[], "subcommand"],
		[["wat"], "list or sample"],
		[["list"], "range"],
		[["sample"], "inventory"],
		[["list", "HEAD", "extra"], "range"],
		[["list", "HEAD", "--limit", "-1"], "limit"],
		[["list", "HEAD", "--limit", "1.5"], "limit"],
		[["list", "HEAD", "--limit", " 1"], "limit"],
		[["list", "HEAD", "--limit", "1 "], "limit"],
		[["list", "HEAD", "--limit", "9007199254740992"], "limit"],
		[["list", "HEAD", "--limit", ""], "limit"],
		[["list", "HEAD", "--all", "--limit", "1"], "limit"],
		[["sample", "inventory.json", "--limit", "1"], "limit"],
		[["sample", "inventory.json", "--all"], "all"],
	])("refuses malformed arguments %j with usage exit", async (args, text) => {
		const io = output();
		expect(await main(["mutants", ...args], io)).toBe(64);
		expect(io.errors.join("")).toContain(text);
	});

	it("reports unreadable inventories, invalid claims and unresolved ranges as failures", async () => {
		const io = output();
		expect(await main(["mutants", "sample", "absent.json"], io)).toBe(1);
		await writeFile(join(repo, "bad.json"), '{"mutants":[],"total":1,"omitted":1,"unmutated":[]}');
		expect(await main(["mutants", "sample", "bad.json"], io)).toBe(1);
		expect(await main(["mutants", "list", "not-a-ref"], io)).toBe(1);
	});
	it("allows multi-digit limits and scopes limit to enumeration", async () => {
		const io = output();
		expect(await main(["mutants", "list", `${base}..${head}`, "--limit", "10"], io)).toBe(0);
		expect(await main(["tools", "--limit", "1"], io)).toBe(64);
		expect(await main(["tools"], io)).toBe(0);
	});
});
