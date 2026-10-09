import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { compilePattern, matchesGlobs } from "../src/pattern.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("this repository's stryker-disable guardrail", () => {
	async function rule() {
		const { config } = await loadConfig(root, { kind: "worktree" }, "");
		const found = config.guardrails["forbidden-patterns"].rules["stryker-disable"];
		if (found === undefined) throw new Error("melian.yaml has no stryker-disable rule");
		const compiled = compilePattern(found.pattern);
		if (!compiled.ok) throw new Error(compiled.reason);
		return { paths: found.paths ?? [], pattern: compiled.pattern };
	}

	it("still matches the comment it forbids", async () => {
		const { pattern } = await rule();
		expect(pattern.test("// Stryker disable next-line all")).toBe(true);
		expect(pattern.test("/* Stryker disable file */")).toBe(true);
	});

	it("matches no line of the source it guards, so it never flags its own code", async () => {
		const { paths, pattern } = await rule();
		const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
			.split("\0")
			.filter((file) => file !== "" && matchesGlobs(paths, file));
		const hits = tracked.flatMap((file) =>
			readFileSync(`${root}/${file}`, "utf8")
				.split("\n")
				.flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : [])),
		);
		expect(tracked.length).toBeGreaterThan(50);
		expect(hits).toEqual([]);
	});
});
