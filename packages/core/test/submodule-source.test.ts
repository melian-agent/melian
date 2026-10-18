import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, Lens, loadConfig, loadStandards } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSource } from "../src/source.ts";
import {
	gitIn,
	isolatedGitEnv,
	lines,
	removeDirectory,
	sourceFor,
	sourceKinds,
	temporaryDirectory,
	writeFiles,
} from "./fixtures/repo.ts";

let repo: string;
let module: string;
beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	module = temporaryDirectory();
	for (const root of [repo, module]) gitIn(root, "init", "--quiet", "--initial-branch=main");
	writeFiles(module, {
		"LENS.md": lines("---", "name: correctness", "extends: correctness", "paths: [nothing/**]", "---"),
		"melian.yaml": "lenses: { correctness: { enabled: false } }\n",
		"AGENTS.md": "MODULE STANDARD",
	});
	gitIn(module, "add", "--all");
	gitIn(module, "commit", "--quiet", "-m", "module policy");
});
afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
	removeDirectory(module);
});

describe.each(sourceKinds)("submodule policy from %s", (kind) => {
	it.each([
		".agents/lenses/correctness",
		".melian/lenses/correctness",
		"services/pay/.agents/lenses/correctness",
		"services/pay/.melian/lenses/correctness",
	])("keeps correctness coverage outside the gitlink %s", async (path) => {
		gitIn(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", module, path);
		const source = sourceFor(repo, kind);
		const loaded = await Lens.load(repo, source, ["services/pay/api.ts"]);
		const correctness = loaded.filter((entry) => entry.name === "correctness");
		expect(correctness.map((entry) => entry.paths)).toEqual([["**"]]);
		expect(Lens.select(correctness, defaultConfig, ["services/pay/api.ts"])[0]?.files).toEqual([
			"services/pay/api.ts",
		]);
		const reader = await openSource(repo, source);
		expect(await reader.exists(path)).toBe("other");
		expect(await reader.list(path)).toBeUndefined();
		expect(await reader.list(path.split("/").slice(0, -1).join("/"))).toContainEqual({
			name: "correctness",
			kind: "other",
		});
		expect(await reader.readText(`${path}/LENS.md`, 1024)).toBeUndefined();
	});

	it("keeps policy and standards inside a submodule absent", async () => {
		gitIn(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", module, "services/pay");
		const source = sourceFor(repo, kind);
		expect((await loadConfig(repo, source, "services/pay/api.ts")).config.lenses.correctness?.enabled).not.toBe(
			false,
		);
		expect(await loadStandards(repo, source, "services/pay/api.ts")).toEqual([]);
	});

	it("preserves symlink refusal when the target is a submodule", async () => {
		gitIn(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", module, "module");
		symlinkSync("module", join(repo, "linked"));
		const reader = await openSource(repo, sourceFor(repo, kind));
		expect(await reader.exists("linked")).toBe("symlink");
		expect(await reader.readText("linked/LENS.md", 1024)).toBeUndefined();
	});
});

it("also refuses an embedded repository with a .git directory", async () => {
	const path = join(repo, "services/pay");
	mkdirSync(path, { recursive: true });
	gitIn(path, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, { "services/pay/melian.yaml": "lenses: { correctness: { enabled: false } }\n" });
	const reader = await openSource(repo, { kind: "worktree" });
	expect(await reader.exists("services/pay")).toBe("other");
	expect(await reader.readText("services/pay/melian.yaml", 1024)).toBeUndefined();
});
