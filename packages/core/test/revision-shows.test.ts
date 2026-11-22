import { type ChangedFile, Revision } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const hunk = (newStart: number, newLines: number, file = "src/a.ts") => ({
	file,
	index: 0,
	oldStart: newStart,
	oldLines: 1,
	newStart,
	newLines,
	header: "",
	text: "",
});

const revision = (...files: ChangedFile[]) => Revision.from({ base: "b", head: "h", files });
const changed = (path: string, ...hunks: ReturnType<typeof hunk>[]): ChangedFile => ({
	status: "modified",
	path,
	binary: false,
	hunks,
});

describe("Revision.shows", () => {
	const shown = revision(changed("src/a.ts", hunk(10, 3)));

	it("shows a range a head-side hunk meets at either end, and none past them", () => {
		expect(shown.shows("src/a.ts", [[12, 14]])).toBe(true);
		expect(shown.shows("src/a.ts", [[8, 10]])).toBe(true);
		expect(shown.shows("src/a.ts", [[13, 13]])).toBe(false);
		expect(shown.shows("src/a.ts", [[9, 9]])).toBe(false);
	});

	it("shows a file when one of its ranges, or one of its hunks, holds the lines", () => {
		expect(
			shown.shows("src/a.ts", [
				[1, 2],
				[11, 11],
			]),
		).toBe(true);
		expect(shown.shows("src/a.ts", [[1, 2]])).toBe(false);
		const two = revision(changed("src/a.ts", hunk(1, 1), hunk(20, 2)));
		expect(two.shows("src/a.ts", [[21, 21]])).toBe(true);
		expect(two.shows("src/a.ts", [[5, 5]])).toBe(false);
	});

	it("shows nothing of a hunk that only deletes, of another file, or for no range", () => {
		const deleted = revision(changed("src/a.ts", hunk(10, 0)));
		expect(deleted.shows("src/a.ts", [[10, 10]])).toBe(false);
		expect(deleted.shows("src/a.ts", [[9, 11]])).toBe(false);
		expect(shown.shows("src/b.ts", [[10, 12]])).toBe(false);
		expect(revision(changed("src/b.ts", hunk(10, 3)), changed("src/a.ts")).shows("src/a.ts", [[10, 12]])).toBe(false);
		expect(shown.shows("src/a.ts", [])).toBe(false);
	});
});
