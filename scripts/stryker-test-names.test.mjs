import { describe, expect, it } from "vitest";
import { strykerTestNames } from "./stryker-test-names.mjs";

function configured() {
	const project = { config: {} };
	strykerTestNames().configureVitest({ project });
	return project.config;
}

describe("strykerTestNames", () => {
	it("lets a pattern of names joined with spaces match a name joined with ' > ', and one joined with spaces", () => {
		const config = configured();
		config.testNamePattern = /doctor mutation testing warns that it skips/;
		expect("doctor mutation testing > warns that it skips").toMatch(config.testNamePattern);
		expect("doctor mutation testing warns that it skips").toMatch(config.testNamePattern);
		expect("doctor mutation testing > warns that it passes").not.toMatch(config.testNamePattern);
	});

	it("keeps the flags, and passes a value that is no regular expression through unchanged", () => {
		const config = configured();
		config.testNamePattern = /A B/i;
		expect("a > b").toMatch(config.testNamePattern);
		config.testNamePattern = undefined;
		expect(config.testNamePattern).toBeUndefined();
		config.testNamePattern = "a b";
		expect(config.testNamePattern).toBe("a b");
	});
});
