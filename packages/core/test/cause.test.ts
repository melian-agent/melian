import { causeOverlap, changeOverlap, classifyCause, type RangeChangeset, resolveRange } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

const original = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];

let repo: string;
let changeset: RangeChangeset;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = temporaryDirectory();
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, { "app.ts": lines(...original), "untouched.ts": lines("u1", "u2"), "gone.ts": lines("g1") });
	gitIn(repo, "add", ".");
	gitIn(repo, "commit", "--quiet", "-m", "base");
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	// Changes line 3, adds two lines after line 7, and deletes line 9.
	writeFiles(repo, {
		"app.ts": lines("l1", "l2", "L3", "l4", "l5", "l6", "l7", "n1", "n2", "l8", "l10"),
		"added.ts": lines("a1"),
		"logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x0d, 0x0a]),
	});
	gitIn(repo, "rm", "--quiet", "gone.ts");
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

	it("calls a location elsewhere in a changed file pre-existing, including beside a deletion", () => {
		const cause = (startLine: number, endLine?: number) =>
			classifyCause({ file: "app.ts", startLine, endLine }, changeset.revision);
		expect(cause(2)).toBe("pre-existing");
		expect(cause(4, 7)).toBe("pre-existing");
		expect(cause(10)).toBe("pre-existing");
		expect(cause(11)).toBe("pre-existing");
	});

	it("calls a location in an added binary file introduced", () => {
		const logo = changeset.revision.files.find((file) => file.path === "logo.png");
		expect(logo).toMatchObject({ status: "added", binary: true, hunks: [] });
		expect(classifyCause({ file: "logo.png", startLine: 1 }, changeset.revision)).toBe("introduced");
	});

	it("calls a range straddling a pure deletion pre-existing", () => {
		expect(classifyCause({ file: "app.ts", startLine: 10, endLine: 11 }, changeset.revision)).toBe("pre-existing");
	});

	it("refuses a location in a file deleted at head", () => {
		expect(() => classifyCause({ file: "gone.ts", startLine: 1 }, changeset.revision)).toThrow(
			expect.objectContaining({ name: "FindingError", code: "deletedFile" }),
		);
	});

	it("compares canonical paths", () => {
		expect(classifyCause({ file: "./app.ts", startLine: 3 }, changeset.revision)).toBe("introduced");
		expect(() => classifyCause({ file: "../app.ts", startLine: 3 }, changeset.revision)).toThrow(
			expect.objectContaining({ code: "invalidPath" }),
		);
	});

	it("calls a location in an unchanged file pre-existing", () => {
		expect(classifyCause({ file: "untouched.ts", startLine: 1 }, changeset.revision)).toBe("pre-existing");
	});
});

describe("classifyCause with evidence", () => {
	const outside = { file: "untouched.ts", startLine: 1 };

	it("calls a location outside the change affected when a cause location overlaps a hunk's new lines", () => {
		expect(classifyCause(outside, changeset.revision, [{ file: "app.ts", startLine: 3, role: "cause" }])).toBe(
			"affected",
		);
		const atHead = { file: "./app.ts", startLine: 6, endLine: 8, role: "cause", revision: "head" } as const;
		expect(classifyCause(outside, changeset.revision, [atHead])).toBe("affected");
	});

	it("calls it affected when a base cause location overlaps a hunk's old lines, a deletion included", () => {
		const deleted = { file: "app.ts", startLine: 9, role: "cause", revision: "base" } as const;
		expect(classifyCause(outside, changeset.revision, [deleted])).toBe("affected");
		const goneFile = { file: "gone.ts", startLine: 1, role: "cause", revision: "base" } as const;
		expect(classifyCause(outside, changeset.revision, [goneFile])).toBe("affected");
	});

	it("keeps it pre-existing for context, for cause outside every hunk, and for a base location on new lines", () => {
		for (const site of [
			{ file: "app.ts", startLine: 3, role: "context" },
			{ file: "app.ts", startLine: 9, role: "context", revision: "base" },
			{ file: "app.ts", startLine: 4, endLine: 7, role: "cause" },
			{ file: "app.ts", startLine: 10, endLine: 11, role: "cause" },
			{ file: "app.ts", startLine: 8, role: "cause", revision: "base" },
			{ file: "untouched.ts", startLine: 1, role: "cause" },
			{ file: "gone.ts", startLine: 1, role: "cause" },
			{ file: "added.ts", startLine: 1, role: "cause", revision: "base" },
			{ file: "logo.png", startLine: 1, role: "cause" },
		] as const) {
			expect(classifyCause(outside, changeset.revision, [site])).toBe("pre-existing");
			expect(causeOverlap(site, changeset.revision)).toBeUndefined();
		}
	});

	it("never lets evidence move a location inside the change off introduced", () => {
		expect(classifyCause({ file: "app.ts", startLine: 3 }, changeset.revision, [])).toBe("introduced");
	});
});

describe("causeOverlap", () => {
	it("returns the hunk a cause location overlaps, on the side it names", () => {
		expect(causeOverlap({ file: "app.ts", startLine: 3, role: "cause" }, changeset.revision)).toMatchObject({
			kind: "hunk",
			hunk: { index: 0 },
		});
		expect(
			causeOverlap({ file: "app.ts", startLine: 9, role: "cause", revision: "base" }, changeset.revision),
		).toMatchObject({ kind: "hunk", hunk: { index: 2 } });
		expect(causeOverlap({ file: "added.ts", startLine: 1, role: "cause" }, changeset.revision)).toMatchObject({
			kind: "hunk",
			hunk: { newStart: 1 },
		});
	});

	it("names a renamed file at the base by its old path", async () => {
		gitIn(repo, "mv", "app.ts", "moved.ts");
		writeFiles(repo, { "moved.ts": lines("l1", "l2", "L3", "l4", "l5", "l6", "l7", "n1", "n2", "l8", "l10", "x") });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "move");
		const moved = await resolveRange(repo, "main...feature");
		const renamed = moved.revision.files.find((file) => file.path === "moved.ts");
		expect(renamed).toMatchObject({ status: "renamed", oldPath: "app.ts" });
		expect(
			causeOverlap({ file: "app.ts", startLine: 9, role: "cause", revision: "base" }, moved.revision),
		).toBeDefined();
		expect(
			causeOverlap({ file: "moved.ts", startLine: 9, role: "cause", revision: "base" }, moved.revision),
		).toBeUndefined();
	});

	it("counts any line of a file renamed without editing, by its old path at the base and its new path at head", async () => {
		gitIn(repo, "mv", "untouched.ts", "kept.ts");
		gitIn(repo, "commit", "--quiet", "-m", "rename only");
		const moved = await resolveRange(repo, "main...feature");
		const renamed = moved.revision.files.find((file) => file.path === "kept.ts");
		expect(renamed).toMatchObject({ status: "renamed", oldPath: "untouched.ts", hunks: [] });
		const atBase = { file: "untouched.ts", startLine: 2, role: "cause", revision: "base" } as const;
		const atHead = { file: "kept.ts", startLine: 1, role: "cause" } as const;
		for (const site of [atBase, atHead]) {
			expect(causeOverlap(site, moved.revision)).toEqual({ kind: "rename", file: renamed });
			expect(classifyCause({ file: "app.ts", startLine: 1 }, moved.revision, [site])).toBe("affected");
		}
		for (const site of [
			{ ...atBase, revision: "head" },
			{ ...atHead, revision: "base" },
		] as const) {
			expect(causeOverlap(site, moved.revision)).toBeUndefined();
		}
		const context = { ...atBase, role: "context" } as const;
		expect(causeOverlap(context, moved.revision)).toBeUndefined();
		expect(changeOverlap(context, moved.revision)).toEqual({ kind: "rename", file: renamed });
	});

	it("keeps a finding inside a file renamed without editing pre-existing when its evidence cites its own lines", async () => {
		gitIn(repo, "mv", "untouched.ts", "kept.ts");
		gitIn(repo, "commit", "--quiet", "-m", "rename only");
		const moved = await resolveRange(repo, "main...feature");
		const inside = { file: "kept.ts", startLine: 2 };
		for (const site of [
			{ file: "kept.ts", startLine: 2, role: "cause" },
			{ file: "untouched.ts", startLine: 2, role: "cause", revision: "base" },
		] as const) {
			expect(classifyCause(inside, moved.revision, [site])).toBe("pre-existing");
			expect(causeOverlap(site, moved.revision, "./kept.ts")).toBeUndefined();
			expect(changeOverlap(site, moved.revision, "kept.ts")).toBeUndefined();
		}
		const edited = { file: "app.ts", startLine: 3, role: "cause" } as const;
		expect(classifyCause(inside, moved.revision, [edited])).toBe("affected");
	});

	it("calls a consumer in another file affected when it cites the file the change only renamed", async () => {
		gitIn(repo, "mv", "untouched.ts", "kept.ts");
		gitIn(repo, "commit", "--quiet", "-m", "rename only");
		const moved = await resolveRange(repo, "main...feature");
		const renamed = moved.revision.files.find((file) => file.path === "kept.ts");
		const consumer = { file: "app.ts", startLine: 1 };
		for (const site of [
			{ file: "untouched.ts", startLine: 1, role: "cause", revision: "base" },
			{ file: "kept.ts", startLine: 1, role: "cause" },
		] as const) {
			expect(classifyCause(consumer, moved.revision, [site])).toBe("affected");
			expect(causeOverlap(site, moved.revision, consumer.file)).toEqual({ kind: "rename", file: renamed });
		}
	});
});
