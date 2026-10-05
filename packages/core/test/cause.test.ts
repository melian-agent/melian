import { Changeset } from "@melian-agent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn, isolatedGitEnv, lines, removeDirectory, temporaryDirectory, writeFiles } from "./fixtures/repo.ts";

const original = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];

let repo: string;
let changeset: Changeset;

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
	changeset = await Changeset.resolve(repo, "main...feature");
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeDirectory(repo);
});

describe("Revision.classifyCause", () => {
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
			changeset.revision.classifyCause({ file: "app.ts", startLine, endLine });
		expect(cause(3)).toBe("introduced");
		expect(cause(8)).toBe("introduced");
		expect(cause(9)).toBe("introduced");
		expect(cause(5, 8)).toBe("introduced");
		expect(changeset.revision.classifyCause({ file: "added.ts", startLine: 1 })).toBe("introduced");
	});

	it("calls a location elsewhere in a changed file pre-existing, including beside a deletion", () => {
		const cause = (startLine: number, endLine?: number) =>
			changeset.revision.classifyCause({ file: "app.ts", startLine, endLine });
		expect(cause(2)).toBe("pre-existing");
		expect(cause(4, 7)).toBe("pre-existing");
		expect(cause(10)).toBe("pre-existing");
		expect(cause(11)).toBe("pre-existing");
	});

	it("calls a location in an added binary file introduced", () => {
		const logo = changeset.revision.files.find((file) => file.path === "logo.png");
		expect(logo).toMatchObject({ status: "added", binary: true, hunks: [] });
		expect(changeset.revision.classifyCause({ file: "logo.png", startLine: 1 })).toBe("introduced");
	});

	it("calls a range straddling a pure deletion pre-existing", () => {
		expect(changeset.revision.classifyCause({ file: "app.ts", startLine: 10, endLine: 11 })).toBe("pre-existing");
	});

	it("refuses a location in a file deleted at head", () => {
		expect(() => changeset.revision.classifyCause({ file: "gone.ts", startLine: 1 })).toThrow(
			expect.objectContaining({ name: "FindingError", code: "deletedFile" }),
		);
	});

	it("compares canonical paths", () => {
		expect(changeset.revision.classifyCause({ file: "./app.ts", startLine: 3 })).toBe("introduced");
		expect(() => changeset.revision.classifyCause({ file: "../app.ts", startLine: 3 })).toThrow(
			expect.objectContaining({ code: "invalidPath" }),
		);
	});

	it("calls a location in an unchanged file pre-existing", () => {
		expect(changeset.revision.classifyCause({ file: "untouched.ts", startLine: 1 })).toBe("pre-existing");
	});
});

describe("Revision.classifyCause with evidence", () => {
	const outside = { file: "untouched.ts", startLine: 1 };

	it("calls a location outside the change affected when a cause location overlaps a hunk's new lines", () => {
		expect(changeset.revision.classifyCause(outside, [{ file: "app.ts", startLine: 3, role: "cause" }])).toBe(
			"affected",
		);
		const atHead = { file: "./app.ts", startLine: 6, endLine: 8, role: "cause", revision: "head" } as const;
		expect(changeset.revision.classifyCause(outside, [atHead])).toBe("affected");
	});

	it("calls it affected when a base cause location overlaps a hunk's old lines, a deletion included", () => {
		const deleted = { file: "app.ts", startLine: 9, role: "cause", revision: "base" } as const;
		expect(changeset.revision.classifyCause(outside, [deleted])).toBe("affected");
		const goneFile = { file: "gone.ts", startLine: 1, role: "cause", revision: "base" } as const;
		expect(changeset.revision.classifyCause(outside, [goneFile])).toBe("affected");
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
			expect(changeset.revision.classifyCause(outside, [site])).toBe("pre-existing");
			expect(changeset.revision.causeOverlap(site)).toBeUndefined();
		}
	});

	it("never lets evidence move a location inside the change off introduced", () => {
		expect(changeset.revision.classifyCause({ file: "app.ts", startLine: 3 }, [])).toBe("introduced");
	});
});

describe("Revision.causeOverlap", () => {
	it("returns the hunk a cause location overlaps, on the side it names", () => {
		expect(changeset.revision.causeOverlap({ file: "app.ts", startLine: 3, role: "cause" })).toMatchObject({
			kind: "hunk",
			hunk: { index: 0 },
		});
		expect(
			changeset.revision.causeOverlap({ file: "app.ts", startLine: 9, role: "cause", revision: "base" }),
		).toMatchObject({ kind: "hunk", hunk: { index: 2 } });
		expect(changeset.revision.causeOverlap({ file: "added.ts", startLine: 1, role: "cause" })).toMatchObject({
			kind: "hunk",
			hunk: { newStart: 1 },
		});
	});

	it("names a renamed file at the base by its old path", async () => {
		gitIn(repo, "mv", "app.ts", "moved.ts");
		writeFiles(repo, { "moved.ts": lines("l1", "l2", "L3", "l4", "l5", "l6", "l7", "n1", "n2", "l8", "l10", "x") });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "move");
		const moved = await Changeset.resolve(repo, "main...feature");
		const renamed = moved.revision.files.find((file) => file.path === "moved.ts");
		expect(renamed).toMatchObject({ status: "renamed", oldPath: "app.ts" });
		expect(
			moved.revision.causeOverlap({ file: "app.ts", startLine: 9, role: "cause", revision: "base" }),
		).toBeDefined();
		expect(
			moved.revision.causeOverlap({ file: "moved.ts", startLine: 9, role: "cause", revision: "base" }),
		).toBeUndefined();
	});

	it("counts any line of a file renamed without editing, by its old path at the base and its new path at head", async () => {
		gitIn(repo, "mv", "untouched.ts", "kept.ts");
		gitIn(repo, "commit", "--quiet", "-m", "rename only");
		const moved = await Changeset.resolve(repo, "main...feature");
		const renamed = moved.revision.files.find((file) => file.path === "kept.ts");
		expect(renamed).toMatchObject({ status: "renamed", oldPath: "untouched.ts", hunks: [] });
		const atBase = { file: "untouched.ts", startLine: 2, role: "cause", revision: "base" } as const;
		const atHead = { file: "kept.ts", startLine: 1, role: "cause" } as const;
		for (const site of [atBase, atHead]) {
			expect(moved.revision.causeOverlap(site)).toEqual({ kind: "rename", file: renamed });
			expect(moved.revision.classifyCause({ file: "app.ts", startLine: 1 }, [site])).toBe("affected");
		}
		for (const site of [
			{ ...atBase, revision: "head" },
			{ ...atHead, revision: "base" },
		] as const) {
			expect(moved.revision.causeOverlap(site)).toBeUndefined();
		}
		const context = { ...atBase, role: "context" } as const;
		expect(moved.revision.causeOverlap(context)).toBeUndefined();
		expect(moved.revision.changeOverlap(context)).toEqual({ kind: "rename", file: renamed });
	});

	it("keeps a finding inside a file renamed without editing pre-existing when its evidence cites its own lines", async () => {
		gitIn(repo, "mv", "untouched.ts", "kept.ts");
		gitIn(repo, "commit", "--quiet", "-m", "rename only");
		const moved = await Changeset.resolve(repo, "main...feature");
		const inside = { file: "kept.ts", startLine: 2 };
		for (const site of [
			{ file: "kept.ts", startLine: 2, role: "cause" },
			{ file: "untouched.ts", startLine: 2, role: "cause", revision: "base" },
		] as const) {
			expect(moved.revision.classifyCause(inside, [site])).toBe("pre-existing");
			expect(moved.revision.causeOverlap(site, "./kept.ts")).toBeUndefined();
			expect(moved.revision.changeOverlap(site, "kept.ts")).toBeUndefined();
		}
		const edited = { file: "app.ts", startLine: 3, role: "cause" } as const;
		expect(moved.revision.classifyCause(inside, [edited])).toBe("affected");
	});

	it("never promotes a finding in a file the change only moved by citing a sibling it also only moved", async () => {
		gitIn(repo, "checkout", "--quiet", "main");
		writeFiles(repo, { "db/query.ts": lines("q1", "q2"), "db/conn.ts": lines("c1", "c2") });
		gitIn(repo, "add", ".");
		gitIn(repo, "commit", "--quiet", "-m", "db");
		gitIn(repo, "checkout", "--quiet", "-b", "move");
		gitIn(repo, "mv", "db", "database");
		gitIn(repo, "commit", "--quiet", "-m", "move db");
		const moved = await Changeset.resolve(repo, "main...move");
		expect(moved.revision.files).toEqual([
			expect.objectContaining({ path: "database/conn.ts", oldPath: "db/conn.ts", status: "renamed", hunks: [] }),
			expect.objectContaining({ path: "database/query.ts", oldPath: "db/query.ts", status: "renamed", hunks: [] }),
		]);
		const renamed = moved.revision.files[0];
		const query = { file: "database/query.ts", startLine: 2 };
		const consumer = { file: "untouched.ts", startLine: 1 };
		for (const site of [
			{ file: "database/conn.ts", startLine: 1, role: "cause" },
			{ file: "db/conn.ts", startLine: 1, role: "cause", revision: "base" },
		] as const) {
			expect(moved.revision.classifyCause(query, [site])).toBe("pre-existing");
			expect(moved.revision.causeOverlap(site, query.file)).toBeUndefined();
			expect(moved.revision.changeOverlap(site, query.file)).toBeUndefined();
			expect(moved.revision.classifyCause(consumer, [site])).toBe("affected");
			expect(moved.revision.causeOverlap(site, consumer.file)).toEqual({ kind: "rename", file: renamed });
		}
	});

	it("calls a consumer in another file affected when it cites the file the change only renamed", async () => {
		gitIn(repo, "mv", "untouched.ts", "kept.ts");
		gitIn(repo, "commit", "--quiet", "-m", "rename only");
		const moved = await Changeset.resolve(repo, "main...feature");
		const renamed = moved.revision.files.find((file) => file.path === "kept.ts");
		const consumer = { file: "app.ts", startLine: 1 };
		for (const site of [
			{ file: "untouched.ts", startLine: 1, role: "cause", revision: "base" },
			{ file: "kept.ts", startLine: 1, role: "cause" },
		] as const) {
			expect(moved.revision.classifyCause(consumer, [site])).toBe("affected");
			expect(moved.revision.causeOverlap(site, consumer.file)).toEqual({ kind: "rename", file: renamed });
		}
	});
});
