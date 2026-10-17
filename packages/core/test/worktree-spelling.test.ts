import { existsSync } from "node:fs";
import type * as fs from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig, Lens, loadStandards } from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openSource } from "../src/source.ts";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

const spellings = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fs>();
	return {
		...actual,
		readdir: async (directory: string, options?: { withFileTypes: boolean }) => {
			if (options?.withFileTypes) return actual.readdir(directory, { withFileTypes: true });
			return (await actual.readdir(directory)).map((name) => spellings.get(join(directory, name)) ?? name);
		},
	};
});

let repo: string;
const lens = lines("---", "name: correctness", "extends: correctness", 'paths: ["nothing/**"]', "---");
const probes = [
	[
		"services/pay/.melian/lenses/correctness/LENſ.md",
		"services/pay/.melian/lenses/correctness/LENS.md",
		"services/pay/api.ts",
	],
	[
		"services/pay/.agents/lenses/correctness/LENſ.md",
		"services/pay/.agents/lenses/correctness/LENS.md",
		"services/pay/api.ts",
	],
	[".agentſ/lenſes/correctness/LENS.md", ".agents/lenses/correctness/LENS.md", "api.ts"],
];

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
});
afterEach(() => {
	spellings.clear();
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

it.for(probes)("refuses the native filesystem alias %s", async ([alias, canonical, path], context) => {
	writeFiles(repo, {
		[alias!]: lens,
		".melian/lenses/marker/LENS.md": lines("---", "name: marker", "extends: correctness", "---"),
		"services/pay/.melian/lenses/marker/LENS.md": lines("---", "name: marker", "extends: correctness", "---"),
	});
	if (!existsSync(join(repo, canonical!)))
		context.skip(
			"This filesystem does not resolve the Unicode alias; the directory-read tests exercise refusal on every host.",
		);
	const loaded = await Lens.load(repo, { kind: "worktree" }, [path!]);
	const correctness = loaded.filter((entry) => entry.name === "correctness");
	expect(correctness.map((entry) => entry.paths)).toEqual([["**"]]);
	expect(Lens.select(correctness, defaultConfig, [path!])[0]?.files).toEqual([path]);
	const reader = await openSource(repo, { kind: "worktree" });
	expect(await reader.readText(canonical!, 1024)).toBeUndefined();
});

it.for(probes)("refuses %s when the directory read supplies its actual spelling", async ([alias, canonical, path]) => {
	writeFiles(repo, { [canonical!]: lens });
	const actual = alias!.split("/");
	const requested = canonical!.split("/");
	for (let index = 0; index < requested.length; index++) {
		if (actual[index] !== requested[index])
			spellings.set(join(repo, ...requested.slice(0, index + 1)), actual[index]!);
	}
	const reader = await openSource(repo, { kind: "worktree" });
	expect(await reader.readText(canonical!, 1024)).toBeUndefined();
	expect(await reader.exists(canonical!)).toBeUndefined();
	expect(await reader.list(canonical!.split("/").slice(0, -1).join("/"))).toEqual(
		alias!.startsWith(".agentſ/") ? undefined : [{ name: "LENS.md", kind: "file" }],
	);
	const loaded = await Lens.load(repo, { kind: "worktree" }, [path!]);
	expect(loaded.filter((entry) => entry.name === "correctness").map((entry) => entry.paths)).toEqual([["**"]]);
});

it("compares names exactly for standards and every parent directory", async () => {
	writeFiles(repo, { "AGENTS.md": "canonical", "docs/rules.md": "nested" });
	const reader = await openSource(repo, { kind: "worktree" });
	expect(await reader.readText("docs/rules.md", 64)).toBe("nested");
	spellings.set(join(repo, "docs"), "Docs");
	expect(await reader.list("docs")).toBeUndefined();
	expect(await reader.readText("docs/rules.md", 64)).toBeUndefined();
	spellings.set(join(repo, "AGENTS.md"), "AGENTſ.md");
	expect(await loadStandards(repo, { kind: "worktree" }, "api.ts")).toEqual([]);
});
