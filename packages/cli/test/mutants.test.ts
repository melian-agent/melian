import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Changeset, MutationInventory, type PullRequest } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import { MutationEnumeration } from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commit, createRepository, gitIn, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import * as target from "../src/target.ts";

const terminalControls = [
	...Array.from({ length: 32 }, (_, index) => index),
	...Array.from({ length: 33 }, (_, index) => index + 0x7f),
	0x61c,
	0x200e,
	0x200f,
	0x2028,
	0x2029,
	...Array.from({ length: 5 }, (_, index) => index + 0x202a),
	...Array.from({ length: 4 }, (_, index) => index + 0x2066),
];

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
	it("lists an empty inventory for a binary Bun dependency-only change", async () => {
		const start = commit(repo, { "package.json": '{"dependencies":{}}\n', "bun.lockb": "\0before" });
		const finish = commit(repo, {
			"package.json": '{"dependencies":{"example":"1.0.0"}}\n',
			"bun.lockb": "\0after",
		});
		expect(gitIn(repo, "diff", "--name-only", start, finish)).toBe("bun.lockb\npackage.json");
		expect(gitIn(repo, "diff", "--numstat", start, finish, "--", "bun.lockb")).toBe("-\t-\tbun.lockb");
		const io = output();
		expect(await main(["mutants", "list", `${start}..${finish}`, "--json"], io)).toBe(0);
		expect(JSON.parse(io.lines.join(""))).toEqual({
			melianMutants: 2,
			range: { base: start, head: finish },
			installation: expect.stringMatching(/^[a-f0-9]{64}$/),
			mutants: [],
			total: 0,
			omitted: 0,
			unmutated: [],
			adapters: [],
		});
		expect(io.errors).toEqual([]);
	});

	it.each(terminalControls.flatMap((code) => ["list", "sample"].map((route) => [code, route] as const)))(
		"escapes terminal control %i through the %s JSON route",
		async (code, route) => {
			const control = String.fromCharCode(code);
			const value = `before${control}after`;
			const input = {
				mutants: [
					{
						file: value,
						line: 1,
						column: 0,
						endLine: 1,
						endColumn: 1,
						mutatorName: value,
						replacement: value,
						statusReason: value,
						claim: "killed",
						evidence: value,
						survivorClasses: [],
					},
				],
				total: 1,
				omitted: 0,
				unmutated: [{ file: value, reason: value }],
			};
			const inventory = MutationInventory.parse(input);
			vi.spyOn(MutationEnumeration.prototype, "list").mockResolvedValue(
				inventory as Awaited<ReturnType<MutationEnumeration["list"]>>,
			);
			await writeFile(join(repo, "controls.json"), JSON.stringify(input));
			const io = output();
			const args = route === "list" ? ["list", `${base}..${head}`, "--json"] : ["sample", "controls.json"];
			const expected = route === "list" ? input : inventory.sample();
			io.lines.length = 0;
			expect(await main(["mutants", ...args], io)).toBe(0);
			const text = io.lines.join("");
			expect(JSON.parse(text)).toEqual(expected);
			const json = JSON.stringify(expected, null, 2);
			const expectedText = code < 32 ? json : json.replaceAll(control, `\\u${code.toString(16).padStart(4, "0")}`);
			expect(text).toBe(`${expectedText}\n`);
			expect(io.errors).toEqual([]);
		},
	);

	it("prints the same safe full-row v2 ignored notes through CLI and compatibility sampling", async () => {
		const value = `before${String.fromCharCode(...terminalControls)}after`;
		const common = { file: "src/a.ts", column: 0, endColumn: 1, mutatorName: "BooleanLiteral", replacement: "true" };
		const inventory = MutationInventory.create({
			range: { base, head },
			adapters: [{ name: "typescript", version: "1", toolVersion: "10.0.0", source: "melian" }],
			installation: "c".repeat(64),
			total: 3,
			omitted: 0,
			unmutated: [],
			mutants: [
				{
					...common,
					line: 1,
					endLine: 1,
					status: "generated",
					claim: "killed",
					evidence: { test: { file: "test/a.test.ts", path: ["guard"] } },
					survivorClasses: [],
				},
				{ ...common, line: 2, endLine: 2, status: "ignored", ignoredBy: "config", statusReason: value },
				{
					...common,
					line: 3,
					endLine: 3,
					status: "ignored",
					ignoredBy: "comment",
					statusReason: value,
					claim: "equivalent",
					evidence: { reason: value },
					survivorClasses: ["some-every"],
				},
			],
		});
		const stored = inventory.toJSON();
		await writeFile(join(repo, "notes.json"), JSON.stringify(stored));
		const expected = {
			selected: [{ ...stored.mutants[0], sampleHash: stored.mutants[0].id }],
			total: 3,
			unmutated: [],
			ignored: { config: [stored.mutants[1]], comment: [stored.mutants[2]] },
		};
		let text = JSON.stringify(expected, null, 2);
		for (const code of terminalControls.filter((code) => code >= 32))
			text = text.replaceAll(String.fromCharCode(code), `\\u${code.toString(16).padStart(4, "0")}`);
		const io = output();
		expect(await main(["mutants", "sample", "notes.json"], io)).toBe(0);
		expect(io.lines.join("")).toBe(`${text}\n`);
		expect(JSON.parse(io.lines.join(""))).toEqual(expected);
		expect(io.errors).toEqual([]);
		const script = fileURLToPath(new URL("../../../scripts/enumerate-mutants.mjs", import.meta.url));
		const child = spawnSync(process.execPath, [script, "--sample", "notes.json"], { cwd: repo, encoding: "utf8" });
		expect(child.status, child.stderr).toBe(0);
		expect(child.stderr).toBe("");
		expect(child.stdout).toBe(`${text}\n`);
		expect(JSON.parse(child.stdout)).toEqual(expected);
	});

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
	it("records the files that owe claims and samples only their mutants", async () => {
		const next = commit(repo, {
			"src/a.ts": "export const flag = true;\n",
			"src/b.ts": "export const other = false;\n",
		});
		const io = output();
		expect(
			await main(["mutants", "list", `${head}..${next}`, "--claims-in", "src/b.ts", "--json", "--all"], io),
		).toBe(0);
		const data = JSON.parse(io.lines.join(""));
		expect(data.claimsIn).toEqual(["src/b.ts"]);
		expect(new Set(data.mutants.map((mutant: { file: string }) => mutant.file))).toEqual(
			new Set(["src/a.ts", "src/b.ts"]),
		);
		const owed = data.mutants.find((mutant: { file: string }) => mutant.file === "src/b.ts");
		Object.assign(owed, {
			claim: "killed",
			evidence: { test: { file: "test/b.test.ts", path: ["b", "works"] } },
			survivorClasses: [],
		});
		await writeFile(join(repo, "owing.json"), JSON.stringify(data));
		io.lines.length = 0;
		expect(await main(["mutants", "sample", "owing.json"], io)).toBe(0);
		expect(JSON.parse(io.lines.join("")).selected.map((mutant: { file: string }) => mutant.file)).toEqual([
			"src/b.ts",
		]);
	});

	it("limits a listing to the named files, which then cannot be sampled", async () => {
		const next = commit(repo, {
			"src/a.ts": "export const flag = true;\n",
			"src/b.ts": "export const other = false;\n",
		});
		const io = output();
		expect(await main(["mutants", "list", `${head}..${next}`, "src/b.ts", "--json", "--all"], io)).toBe(0);
		const data = JSON.parse(io.lines.join(""));
		expect(data.limitedTo).toEqual(["src/b.ts"]);
		expect(data.mutants.map((mutant: { file: string }) => mutant.file)).toEqual(["src/b.ts"]);
		Object.assign(data.mutants[0], {
			claim: "killed",
			evidence: { test: { file: "test/b.test.ts", path: ["b", "works"] } },
			survivorClasses: [],
		});
		await writeFile(join(repo, "limited.json"), JSON.stringify(data));
		io.lines.length = 0;
		expect(await main(["mutants", "sample", "limited.json"], io)).toBe(1);
		expect(io.errors.join("")).toContain("for reading");
	});

	it("refuses a named file the range does not change, by name", async () => {
		const io = output();
		expect(await main(["mutants", "list", `${base}..${head}`, "src/a.ts", "src/typo.ts", "--json"], io)).toBe(1);
		expect(io.lines).toEqual([]);
		expect(io.errors.join("")).toContain('"src/typo.ts" is not a file this range changes');
		io.errors.length = 0;
		expect(await main(["mutants", "list", `${base}..${head}`, "--claims-in", "src/typo.ts", "--json"], io)).toBe(1);
		expect(io.lines).toEqual([]);
		expect(io.errors.join("")).toContain('"src/typo.ts" is not a file this range changes');
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
		expect(JSON.parse(io.lines.join(""))).toEqual({
			selected: [{ ...data.mutants[0], sampleHash: data.mutants[0].id }],
			total: data.total,
			unmutated: data.unmutated,
			ignored: { config: [], comment: [] },
		});
		const legacy = {
			mutants: [{ ...data.mutants[0], evidence: "a.test.ts > flags works" }],
			total: 1,
			omitted: 0,
			unmutated: [],
		};
		await writeFile(join(repo, "legacy.json"), JSON.stringify(legacy));
		io.lines.length = 0;
		expect(await main(["mutants", "sample", "legacy.json"], io)).toBe(0);
		expect(JSON.parse(io.lines.join(""))).toEqual({
			selected: [{ ...legacy.mutants[0], sampleHash: data.mutants[0].id }],
			total: 1,
			unmutated: [],
		});
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
		[["sample", "x.json", "--claims-in", "src/a.ts"], "--claims-in is only available for mutants list"],
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

	it("refuses --claims-in on any other command", async () => {
		const io = output();
		expect(await main(["findings", "HEAD", "--claims-in", "src/a.ts"], io)).toBe(64);
		expect(io.errors.join("")).toContain("--claims-in is only available for mutants list");
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
