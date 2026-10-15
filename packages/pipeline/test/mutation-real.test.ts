import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Changeset, defaultConfig } from "@melian-agent/core";
import { backgroundContext, createNodeExecutionEnv, runStaticTool } from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

const checkout = fileURLToPath(new URL("../../..", import.meta.url));
const own = (path: string) => readFileSync(join(checkout, path), "utf8");

// Every other mutation test runs a fake Stryker. Problem: the fakes passed while the real run took an hour and overran
// its timeout, and nothing small showed it. This runs the real Stryker and Vitest on a two-module project, with the
// repository's own Stryker and Vitest configuration. Inside a mutation run it would start a second Stryker for every
// test run of the first, so it skips there.
const inMutationRun = process.env.MELIAN_MUTATION !== undefined;

let repo: string;

beforeEach(() => {
	repo = createRepository();
});

afterEach(() => {
	removeRepository(repo);
});

const source = (name: string, otherwise: string) =>
	lines(`export function ${name}(x: number) {`, "  if (x > 0) return 1;", `  return ${otherwise};`, "}");

// Inside a describe, so the covering test's name has the nesting Stryker and Vitest spell differently. A weak test
// asserts only the type, so the mutants of its function survive.
const test = (name: string, weak = false) =>
	lines(
		'import { describe, expect, it } from "vitest";',
		`import { ${name} } from "../src/${name}.ts";`,
		`describe("${name}", () => {`,
		`  it("${name}", () => {`,
		...(weak
			? [`    expect(typeof ${name}(0)).toBe("number");`]
			: [`    expect(${name}(1)).toBe(1);`, `    expect(${name}(0)).toBe(0);`]),
		"  });",
		"});",
	);

describe.skipIf(inMutationRun)("the real backend", { timeout: 180_000 }, () => {
	it("uses Vitest related selection and judges the changed line within a minute", async () => {
		const project = {
			"package.json": '{"type":"module"}\n',
			"tsconfig.json":
				'{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","target":"es2022","allowImportingTsExtensions":true,"noEmit":true}}\n',
			"vitest.config.ts":
				'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts"] } });\n',
			"vitest.stryker.config.ts": own("vitest.stryker.config.ts"),
			"scripts/stryker-test-names.mjs": own("scripts/stryker-test-names.mjs"),
			"stryker.config.json": own("stryker.config.json"),
			"packages/p/src/b.ts": source("b", "0"),
			"packages/p/test/b.test.ts": test("b"),
			"packages/p/test/a.test.ts": test("a"),
			"packages/p/test/c.test.ts": test("c", true),
		};
		const base = commit(repo, {
			".gitignore": "node_modules\n",
			...project,
			"packages/p/src/a.ts": source("a", "0"),
			"packages/p/src/c.ts": source("c", "0"),
		});
		const head = commit(repo, {
			"packages/p/src/a.ts": source("a", "2 - 2"),
			"packages/p/src/c.ts": source("c", "2 - 2"),
		});
		// The project gets an install of its own, cloned where the file system can, so it resolves nothing from this checkout.
		const clone = process.platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];
		execFileSync("cp", [...clone, join(checkout, "node_modules"), join(repo, "node_modules")]);
		rmSync(join(repo, "node_modules/@melian-agent"), { recursive: true, force: true });
		const revision = (await Changeset.resolve(repo, `${base}..${head}`)).revision;
		const started = Date.now();
		const result = await runStaticTool(
			{
				env: createNodeExecutionEnv(repo),
				repoRoot: repo,
				base,
				commit: head,
				tool: "mutation",
				headCode: "writer",
				settings: { ...defaultConfig.static.mutation, timeout: 60 },
				revision,
			},
			backgroundContext,
		);
		expect(result.status).toBe("ran");
		if (result.status !== "ran") return;
		expect(result.notes.join("\n")).toContain("related test file(s) selected by Vitest");
		// The well-tested change is judged killed and the weakly tested one survives, so the tests ran against the mutants.
		const judged = result.log.runs[0]!.results.map((each) => [
			each.ruleId,
			each.locations?.[0]?.physicalLocation?.artifactLocation?.uri,
		]);
		expect(judged.length).toBeGreaterThan(0);
		expect(new Set(judged.map(String))).toEqual(new Set(["untested-behaviour,packages/p/src/c.ts"]));
		expect(Date.now() - started).toBeLessThan(60_000);
	});

	// Line 10 is weakly tested, so its mutant survives; line 50 is well tested. Each head is judged with the one before it
	// as the last judged head of the same review target.
	it("reruns only the mutants a later head changes or whose killing test changed, and keeps the earlier survivor", async () => {
		const padding = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, index) => `// line ${from + index}`);
		const module = (weak: string, strong: string) =>
			lines(
				...padding(1, 7),
				"export function weak(x: number) {",
				"  if (x > 0) return 1;",
				`  return ${weak};`,
				"}",
				...padding(12, 49),
				`export function strong(x: number) { return ${strong}; }`,
			);
		const testOf = (name: string, body: string[]) =>
			lines(
				'import { describe, expect, it } from "vitest";',
				`import { ${name} } from "../src/m.ts";`,
				`describe("${name}", () => {`,
				`  it("${name}", () => {`,
				...body.map((line) => `    ${line}`),
				"  });",
				"});",
			);
		const base = commit(repo, {
			".gitignore": "node_modules\n",
			"package.json": '{"type":"module"}\n',
			"tsconfig.json":
				'{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","target":"es2022","allowImportingTsExtensions":true,"noEmit":true}}\n',
			"vitest.config.ts":
				'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts"] } });\n',
			"vitest.stryker.config.ts": own("vitest.stryker.config.ts"),
			"scripts/stryker-test-names.mjs": own("scripts/stryker-test-names.mjs"),
			"stryker.config.json": own("stryker.config.json"),
			"packages/p/src/m.ts": module("0", "x"),
			"packages/p/test/weak.test.ts": testOf("weak", ['expect(typeof weak(0)).toBe("number");']),
			"packages/p/test/strong.test.ts": testOf("strong", ["expect(strong(3)).toBeGreaterThan(0);"]),
		});
		const clone = process.platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"];
		execFileSync("cp", [...clone, join(checkout, "node_modules"), join(repo, "node_modules")]);
		rmSync(join(repo, "node_modules/@melian-agent"), { recursive: true, force: true });
		const judge = async (head: string) => {
			const revision = (await Changeset.resolve(repo, `${base}..${head}`)).revision;
			const result = await runStaticTool(
				{
					env: createNodeExecutionEnv(repo),
					repoRoot: repo,
					base,
					commit: head,
					tool: "mutation",
					headCode: "writer",
					target: "range-feature",
					settings: { ...defaultConfig.static.mutation, timeout: 120 },
					revision,
				},
				backgroundContext,
			);
			if (result.status !== "ran") throw new Error(`skipped: ${result.reason}`);
			const survivors = result.log.runs[0]!.results.map(
				(each) => each.locations?.[0]?.physicalLocation?.region?.startLine,
			);
			const reuse = result.notes.find((note) => note.startsWith("Stryker reused"));
			return { head, survivors, reuse, notes: result.notes };
		};
		const first = await judge(
			commit(repo, {
				"packages/p/src/m.ts": module("2 - 2", "x * 2"),
				"packages/p/test/strong.test.ts": testOf("strong", ["expect(strong(3)).toBe(6);"]),
			}),
		);
		expect(first.survivors).toEqual([10]);
		expect(first.notes).toContain("Stryker started cold: this review target has no earlier judged head.");
		// Line 10 has one mutant and line 50 two. Only line 50 changes, so only its mutants run; line 10's survivor is reused
		// and is still a finding.
		const reused = (count: number, from: string, ran: number) =>
			`Stryker reused ${count} of 3 mutant result(s) from ${from.slice(0, 12)}, the last judged head, and ran ${ran}.`;
		const second = await judge(commit(repo, { "packages/p/src/m.ts": module("2 - 2", "x + x") }));
		expect(second.survivors).toEqual([10]);
		expect(second.reuse).toBe(reused(1, first.head, 2));
		// The test that kills line 50's mutants changes, so they run again; line 10's survivor is reused once more.
		const third = await judge(
			commit(repo, {
				"packages/p/test/strong.test.ts": testOf("strong", [
					"expect(strong(3)).toBe(6);",
					"expect(strong(0)).toBe(0);",
				]),
			}),
		);
		expect(third.survivors).toEqual([10]);
		expect(third.reuse).toBe(reused(1, second.head, 2));
		// Neither a changed line nor a changed test: every result is reused.
		const fourth = await judge(commit(repo, { "NOTES.md": "a later head that changes no code\n" }));
		expect(fourth.survivors).toEqual([10]);
		expect(fourth.reuse).toBe(reused(3, third.head, 0));
	});
});
