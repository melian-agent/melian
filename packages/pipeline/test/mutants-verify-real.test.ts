import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Changeset, defaultConfig, MutantsVerdict, MutationInventory } from "@melian-agent/core";
import { backgroundContext, createNodeExecutionEnv, MutationEnumeration, runMutantsVerify } from "@melian-agent/pipeline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

const checkout = fileURLToPath(new URL("../../..", import.meta.url));
const own = (path: string) => readFileSync(join(checkout, path), "utf8");

// The real Stryker and Vitest on a small project, with the repository's own Stryker configuration. Inside a mutation run
// it would start a second Stryker for every test run of the first, so it skips there.
const inMutationRun = process.env.MELIAN_MUTATION !== undefined;

const positive = (name: string) => lines(`export function ${name}(x: number) {`, "  return x > 0;", "}");
const negate = (name: string) => lines(`export function ${name}(x: number) {`, "  return -x;", "}");

const strong = (name: string) =>
	lines(
		'import { describe, expect, it } from "vitest";',
		`import { ${name} } from "../src/${name}.ts";`,
		`describe("${name}", () => {`,
		`  it("works", () => {`,
		`    expect(${name}(1)).toBe(true);`,
		`    expect(${name}(0)).toBe(false);`,
		"  });",
		"});",
	);

const weak = (name: string) =>
	lines(
		'import { expect, it } from "vitest";',
		`import { ${name} } from "../src/${name}.ts";`,
		`it("returns a boolean", () => expect(typeof ${name}(1)).toBe("boolean"));`,
	);

// A test that fails whenever a marker an earlier run left exists, and writes it, so every run after the first fails for
// a reason no mutant gave it. With `cleans`, the failing run removes the marker, so the next run passes again.
const leftover = (name: string, cleans: boolean) =>
	lines(
		'import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";',
		'import { expect, it } from "vitest";',
		`import { ${name} } from "../src/${name}.ts";`,
		`it("negates", () => {`,
		'  if (existsSync("tmp/seen")) {',
		...(cleans ? ['    rmSync("tmp/seen");'] : []),
		'    throw new Error("an earlier run left tmp/seen");',
		"  }",
		'  mkdirSync("tmp", { recursive: true });',
		'  writeFileSync("tmp/seen", "");',
		`  expect(typeof ${name}(1)).toBe("number");`,
		"});",
	);

let repo: string;
let base: string;

beforeAll(() => {
	repo = createRepository();
	base = commit(repo, {
		".gitignore": "node_modules\ntmp\n",
		"package.json": '{"type":"module"}\n',
		"tsconfig.json":
			'{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","target":"es2022","allowImportingTsExtensions":true,"noEmit":true}}\n',
		"vitest.config.ts":
			'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts"] } });\n',
		"vitest.stryker.config.ts": own("vitest.stryker.config.ts"),
		"scripts/stryker-test-names.mjs": own("scripts/stryker-test-names.mjs"),
		"stryker.config.json": own("stryker.config.json"),
		"packages/p/src/keep.ts": lines("export const keep = 1;"),
	});
	const clone = process.platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];
	execFileSync("cp", [...clone, join(checkout, "node_modules"), join(repo, "node_modules")]);
	rmSync(join(repo, "node_modules/@melian-agent"), { recursive: true, force: true });
});

afterAll(() => {
	removeRepository(repo);
});

// Commits `files` on top of the base, runs a verify over `listed`, and decides it with no answers.
async function verify(files: Record<string, string>, listed: readonly string[]) {
	execFileSync("git", ["-C", repo, "checkout", "-q", "--detach", base]);
	const head = commit(repo, files);
	const range = `${base}..${head}`;
	const { revision } = await Changeset.resolve(repo, range);
	const inventory = (await (await MutationEnumeration.open(repo, range)).list({ all: true })).toJSON();
	const run = await runMutantsVerify(
		{
			env: createNodeExecutionEnv(repo),
			repoRoot: repo,
			commit: head,
			base,
			tool: "mutation",
			settings: defaultConfig.static.mutation,
			revision,
			headCode: "reviewer",
		},
		{ files: listed, config: own("stryker.config.json") },
		backgroundContext,
	);
	const verdict = MutantsVerdict.decide({
		head,
		tree: "0".repeat(64),
		files: listed,
		mutants: inventory.mutants.filter((row) => listed.includes(row.file)),
		setAside: inventory.unmutated.filter((entry) => listed.includes(entry.file)),
		report: run.report,
		noTests: run.noTests,
		endCheck: run.endCheck,
		answers: undefined,
	});
	return { run, verdict };
}

describe.skipIf(inMutationRun)("mutants verify on the real Stryker", { timeout: 300_000 }, () => {
	it("passes a file whose tests catch every mutant, matching each by Stryker's columns", async () => {
		const { verdict } = await verify(
			{ "packages/p/src/a.ts": positive("a"), "packages/p/test/a.test.ts": strong("a") },
			["packages/p/src/a.ts"],
		);
		expect(verdict.undecided).toBeUndefined();
		expect(verdict.lines.length).toBeGreaterThan(0);
		expect(verdict.lines.every((line) => line.outcome === "caught")).toBe(true);
		expect(verdict.exitCode()).toBe(0);
	});

	it("fails a file whose test lets its mutants survive", async () => {
		const { verdict } = await verify(
			{ "packages/p/src/c.ts": positive("c"), "packages/p/test/c.test.ts": weak("c") },
			["packages/p/src/c.ts"],
		);
		expect(verdict.lines.some((line) => line.outcome === "survivor" && line.status === "Survived")).toBe(true);
		expect(verdict.exitCode()).toBe(1);
	});

	it("counts the mutants of a file no test reaches as uncovered when the dry run finds no test", async () => {
		const { run, verdict } = await verify({ "packages/p/src/e.ts": positive("e") }, ["packages/p/src/e.ts"]);
		expect(run.report).toBeUndefined();
		expect(run.noTests).toBe(true);
		expect(verdict.lines.every((line) => line.outcome === "survivor" && line.status === "NoCoverage")).toBe(true);
		expect(verdict.exitCode()).toBe(1);
	});

	it("turns a kill a persistent leftover caused into a survivor, by the end check", async () => {
		const { run, verdict } = await verify(
			{ "packages/p/src/d.ts": negate("d"), "packages/p/test/d.test.ts": leftover("d", false) },
			["packages/p/src/d.ts"],
		);
		expect(run.endCheck).toEqual({ "packages/p/test/d.test.ts": false });
		expect(verdict.lines.map((line) => [line.outcome, line.status])).toEqual([["survivor", "Killed, not confirmed"]]);
		expect(verdict.exitCode()).toBe(1);
	});

	// The known limit, recorded as a test: a leftover that is gone again before the end check passes it.
	it("misses a leftover that the run removed before the end check", async () => {
		const { run, verdict } = await verify(
			{ "packages/p/src/f.ts": negate("f"), "packages/p/test/f.test.ts": leftover("f", true) },
			["packages/p/src/f.ts"],
		);
		expect(run.endCheck).toEqual({ "packages/p/test/f.test.ts": true });
		expect(verdict.lines.map((line) => line.outcome)).toEqual(["caught"]);
		expect(verdict.exitCode()).toBe(0);
	});
});

// Keeps the import in use when the inventory type is only read through `toJSON`.
void MutationInventory;
