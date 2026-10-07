import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import base from "../vitest.config.ts";
import stryker from "../vitest.stryker.config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("the Vitest configuration Stryker runs", () => {
	it("adds the stryker-test-names plugin to the base configuration and keeps its tests", () => {
		expect(stryker.plugins.map((plugin) => plugin.name)).toContain("stryker-test-names");
		expect(stryker.test.include).toEqual(base.test.include);
	});

	it("is the file stryker.config.json names", () => {
		const { vitest } = JSON.parse(readFileSync(resolve(root, "stryker.config.json"), "utf8"));
		expect(resolve(root, vitest.configFile)).toBe(resolve(root, "vitest.stryker.config.ts"));
	});
});
