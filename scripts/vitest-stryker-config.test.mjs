import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import base from "../vitest.config.ts";
import stryker from "../vitest.stryker.config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("the Vitest configuration Stryker runs", () => {
	it("keeps the base configuration's tests", () => {
		expect(stryker.test.include).toEqual(base.test.include);
	});

	it("carries the stryker-test-names plugin, whose configureVitest makes a pattern of spaced names match a nested Vitest name", () => {
		const plugin = stryker.plugins.find((each) => each.name === "stryker-test-names");
		expect(plugin).toBeDefined();
		const project = { config: {} };
		plugin.configureVitest({ project });
		project.config.testNamePattern = /doctor mutation testing warns that it skips/;
		expect("doctor mutation testing > warns that it skips").toMatch(project.config.testNamePattern);
		expect("doctor mutation testing > warns that it passes").not.toMatch(project.config.testNamePattern);
	});

	it("is the file stryker.config.json names", () => {
		const { vitest } = JSON.parse(readFileSync(resolve(root, "stryker.config.json"), "utf8"));
		expect(resolve(root, vitest.configFile)).toBe(resolve(root, "vitest.stryker.config.ts"));
	});
});

it("excludes string mutations of sandbox policy and command flags", () => {
	const config = JSON.parse(readFileSync(resolve(root, "stryker.config.json"), "utf8"));
	expect(config.mutator.excludedMutations).toEqual(["StringLiteral"]);
});

it("replaces base globs with the supplied include list, while keeping the names plugin", () => {
	const directory = mkdtempSync(join(tmpdir(), "stryker-include-"));
	const file = join(directory, "include.json");
	const include = ["packages/p/test/a.test.ts", "packages/p/test/setup.ts"];
	writeFileSync(file, JSON.stringify(include));
	try {
		const code = `import config from ${JSON.stringify(pathToFileURL(resolve(root, "vitest.stryker.config.ts")).href)}; console.log(JSON.stringify(config));`;
		const selected = JSON.parse(
			execFileSync(process.execPath, ["--input-type=module", "-e", code], {
				env: { ...process.env, MELIAN_MUTATION_TEST_INCLUDE: file },
				encoding: "utf8",
			}),
		);
		expect(selected.test.include).toEqual(include);
		expect(selected.plugins.some((plugin) => plugin.name === "stryker-test-names")).toBe(true);
	} finally {
		rmSync(directory, { recursive: true });
	}
});
