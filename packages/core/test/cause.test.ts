import { classifyCause, type RangeChangeset, resolveRange } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

const original = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];

let repo: string;
let changeset: RangeChangeset;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, { "app.ts": lines(...original), "untouched.ts": lines("u1", "u2") });
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "--quiet", "-m", "base");
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	// Changes line 3, adds two lines after line 7, and deletes line 9.
	writeFiles(repo, {
		"app.ts": lines("l1", "l2", "L3", "l4", "l5", "l6", "l7", "n1", "n2", "l8", "l10"),
		"added.ts": lines("a1"),
	});
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "--quiet", "-m", "feature");
	changeset = await resolveRange(repo, "main...feature");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

describe("classifyCause", () => {
	it("works from the hunks this test expects", () => {
		const app = changeset.revision.files.find((file) => file.path === "app.ts");
		expect(
			app?.hunks.map(({ oldStart, oldLines, newStart, newLines }) => [oldStart, oldLines, newStart, newLines]),
		).toEqual([
			[3, 1, 3, 1],
			[7, 0, 8, 2],
			[9, 1, 10, 0],
		]);
	});

	it("calls a location inside a hunk's new lines introduced", () => {
		const cause = (startLine: number, endLine?: number) =>
			classifyCause({ file: "app.ts", startLine, endLine }, changeset.revision);
		expect(cause(3)).toBe("introduced");
		expect(cause(8)).toBe("introduced");
		expect(cause(9)).toBe("introduced");
		expect(cause(5, 8)).toBe("introduced");
		expect(classifyCause({ file: "added.ts", startLine: 1 }, changeset.revision)).toBe("introduced");
	});

	it("calls a location elsewhere in a changed file affected, including beside a deletion", () => {
		const cause = (startLine: number, endLine?: number) =>
			classifyCause({ file: "app.ts", startLine, endLine }, changeset.revision);
		expect(cause(2)).toBe("affected");
		expect(cause(4, 7)).toBe("affected");
		expect(cause(10)).toBe("affected");
		expect(cause(11)).toBe("affected");
	});

	it("calls a location in an unchanged file pre-existing", () => {
		expect(classifyCause({ file: "untouched.ts", startLine: 1 }, changeset.revision)).toBe("pre-existing");
	});
});
