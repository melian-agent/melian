import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ChangesetError, loadConfig, Revision, type RevisionScope } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { compilePattern, matchesGlobs } from "../src/pattern.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);

describe("Revision.key", () => {
	it("keys the whole diff as the base and head", () => {
		expect(Revision.key({ base, head })).toBe(`${base}..${head}`);
		expect(Revision.key({ base, head }, "diff")).toBe(`${base}..${head}`);
		expect(Revision.key(Revision.from({ base, head, files: [] }), "diff")).toBe(`${base}..${head}`);
	});

	it("refuses a scope it does not know", () => {
		const call = () => Revision.key({ base, head }, "delta" as RevisionScope);
		expect(call).toThrow(ChangesetError);
		expect(call).toThrow(/scope "delta"/);
		try {
			call();
		} catch (error) {
			expect((error as ChangesetError).code).toBe("unknownScope");
		}
	});

	it("reads a key back into its sides and scope", () => {
		expect(Revision.parseKey(Revision.key({ base, head }))).toEqual({ base, head, scope: "diff" });
	});

	it.each(["", base, `${base}..`, `..${head}`, `${base}..${head}..${head}`, `${base}...${head}`])(
		"reads %j as no key",
		(text) => {
			expect(Revision.parseKey(text)).toBeUndefined();
		},
	);

	it("displays a key with each side cut to twelve characters", () => {
		expect(Revision.display({ base: `${"a".repeat(12)}c`, head: `${"b".repeat(12)}d` })).toBe(
			`${"a".repeat(12)}..${"b".repeat(12)}`,
		);
	});
});

const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("this repository's hand-built-revision-key guardrail", () => {
	async function rule() {
		const { config } = await loadConfig(root, { kind: "worktree" }, "");
		const found = config.guardrails["forbidden-patterns"].rules["hand-built-revision-key"];
		if (found === undefined) throw new Error("melian.yaml has no hand-built-revision-key rule");
		const compiled = compilePattern(found.pattern);
		if (!compiled.ok) throw new Error(compiled.reason);
		return { paths: found.paths ?? [], pattern: compiled.pattern };
	}

	it("matches a key built by hand", async () => {
		const { pattern } = await rule();
		// Built from a placeholder, since a "${" inside a plain string reads to Biome as a template typed by mistake.
		const source = (line: string) => line.replaceAll("@{", "\u0024{");
		expect(pattern.test(source("return `@{revision.base}..@{revision.head}`;"))).toBe(true);
		expect(pattern.test(source("`@{round.base.slice(0, 12)}..@{round.head.slice(0, 12)}; done`"))).toBe(true);
		expect(pattern.test(source("`@{a}...@{b}`"))).toBe(false);
		expect(pattern.test(source("`@{a}.@{b}`"))).toBe(false);
	});

	it("guards every package's source and no test", async () => {
		const { paths } = await rule();
		expect(matchesGlobs(paths, "packages/pipeline/src/rounds.ts")).toBe(true);
		expect(matchesGlobs(paths, "packages/core/test/revision-key.test.ts")).toBe(false);
	});

	it("matches no line of the source it guards, so every key comes from Revision.key", async () => {
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
