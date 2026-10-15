import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
