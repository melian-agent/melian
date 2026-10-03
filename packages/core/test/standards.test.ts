import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { loadStandards, OutsideRepositoryError } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

let parent: string;
let repo: string;

// The layout Melian itself uses: CLAUDE.md stubs that import AGENTS.md, and a package AGENTS.md importing a guideline.
beforeEach(() => {
	parent = temporaryDirectory();
	repo = join(parent, "repo");
	writeFiles(parent, { "private.md": lines("outside the repository") });
	writeFiles(repo, {
		"AGENTS.md": lines("# Root rules", "@docs/guide.md", "@../private.md"),
		"CLAUDE.md": lines("@AGENTS.md"),
		"docs/guide.md": lines("# Guide", "@more.md"),
		"docs/more.md": lines("two imports deep"),
		".melian/standards/naming.md": lines("# Naming"),
		".melian/standards/notes.txt": lines("not markdown"),
		"packages/app/AGENTS.md": lines("# App rules", "@../../docs/app-guide.md", "```", "@not-an-import.md", "```"),
		"packages/app/CLAUDE.md": lines("@AGENTS.md"),
		"docs/app-guide.md": lines("# App guide"),
	});
});

afterEach(() => {
	removeDirectory(parent);
});

describe("loadStandards", () => {
	it("walks nearest-first, follows imports one level, and skips import-only stubs", async () => {
		const sections = await loadStandards(repo, "packages/app/src/index.ts");

		expect(sections.map(({ path, importedBy }) => ({ path, importedBy }))).toEqual([
			{ path: "packages/app/AGENTS.md", importedBy: undefined },
			{ path: "docs/app-guide.md", importedBy: "packages/app/AGENTS.md" },
			{ path: "AGENTS.md", importedBy: undefined },
			{ path: "docs/guide.md", importedBy: "AGENTS.md" },
			{ path: ".melian/standards/naming.md", importedBy: undefined },
		]);
		expect(sections[0]!.content).toBe(
			lines("# App rules", "@../../docs/app-guide.md", "```", "@not-an-import.md", "```"),
		);
	});

	it("keeps a CLAUDE.md that has content of its own", async () => {
		writeFiles(repo, { "CLAUDE.md": lines("# Claude-only notes", "@AGENTS.md") });
		const sections = await loadStandards(repo, "README.md");
		expect(sections.map(({ path }) => path)).toEqual([
			"AGENTS.md",
			"docs/guide.md",
			"CLAUDE.md",
			".melian/standards/naming.md",
		]);
	});

	it("reads a file reached through a symlink once", async () => {
		rmSync(join(repo, "packages/app/CLAUDE.md"));
		symlinkSync("AGENTS.md", join(repo, "packages/app/CLAUDE.md"));
		const sections = await loadStandards(repo, "packages/app");
		expect(sections.filter(({ content }) => content.startsWith("# App rules"))).toHaveLength(1);
	});

	it("follows the imports of a file a nearer directory already imported", async () => {
		writeFiles(repo, { "packages/app/AGENTS.md": lines("# App rules", "@../../AGENTS.md") });
		const sections = await loadStandards(repo, "packages/app");
		expect(sections.map(({ path, importedBy }) => ({ path, importedBy }))).toEqual([
			{ path: "packages/app/AGENTS.md", importedBy: undefined },
			{ path: "AGENTS.md", importedBy: "packages/app/AGENTS.md" },
			{ path: "docs/guide.md", importedBy: "AGENTS.md" },
			{ path: ".melian/standards/naming.md", importedBy: undefined },
		]);
	});

	it("returns nothing for a repository without standards", async () => {
		const empty = join(parent, "empty");
		writeFiles(empty, { "src/a.ts": "" });
		expect(await loadStandards(empty, "src/a.ts")).toEqual([]);
	});

	it("refuses a path outside the repository", async () => {
		await expect(loadStandards(repo, "../private.md")).rejects.toBeInstanceOf(OutsideRepositoryError);
	});
});
