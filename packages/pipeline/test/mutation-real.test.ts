import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Changeset, defaultConfig } from "@melian-agent/core";
import { backgroundContext, createNodeExecutionEnv, runStaticTool } from "@melian-agent/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sandbox } from "../src/sandbox.ts";
import { commit, createRepository, lines, removeRepository } from "./fixtures/repo.ts";

const checkout = fileURLToPath(new URL("../../..", import.meta.url));
const own = (path: string) => readFileSync(join(checkout, path), "utf8");

// Every other mutation test runs a fake Stryker. Problem: the fakes passed while the real run, under the real sandbox,
// took an hour and overran its timeout, and nothing small showed it. This runs the real Stryker, Vitest, and sandbox on a
// two-module project, with the repository's own Stryker and Vitest configuration.
const hostSandbox = Sandbox.detect();
const inSandbox = process.env.MELIAN_SANDBOX !== undefined;

let repo: string;

beforeEach(() => {
	repo = createRepository();
});

afterEach(() => {
	removeRepository(repo);
});

const source = (name: string, otherwise: string) =>
	lines(`export function ${name}(x: number) {`, "  if (x > 0) return 1;", `  return ${otherwise};`, "}");

const test = (name: string) =>
	lines(
		'import { expect, it } from "vitest";',
		`import { ${name} } from "../src/${name}.ts";`,
		`it("${name}", () => {`,
		`  expect(${name}(1)).toBe(1);`,
		`  expect(${name}(0)).toBe(0);`,
		"});",
	);

describe.skipIf(hostSandbox === undefined || inSandbox)("the real backend", { timeout: 180_000 }, () => {
	it("gets past the dry run on the related test alone and judges the changed line within a minute", async () => {
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
		};
		const base = commit(repo, {
			".gitignore": "node_modules\n",
			...project,
			"packages/p/src/a.ts": source("a", "0"),
		});
		const head = commit(repo, { "packages/p/src/a.ts": source("a", "2 - 2") });
		// The sandbox reads an install only where it lies, so the project gets a copy, cloned where the file system can.
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
				trustedWriter: true,
				settings: { ...defaultConfig.static.mutation, timeout: 60 },
				revision,
			},
			backgroundContext,
		);
		expect(result.status).toBe("ran");
		if (result.status !== "ran") return;
		expect(result.notes.join("\n")).toContain("selected 1 related test file(s)");
		expect(Date.now() - started).toBeLessThan(60_000);
	});
});
