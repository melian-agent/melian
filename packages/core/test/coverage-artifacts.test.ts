import { type ChangedFile, ReviewCoverage, TestCoverage } from "@melian-agent/core";
import { expect, it } from "vitest";

const tree = "a".repeat(40);
const renamed: ChangedFile = {
	path: "new.ts",
	oldPath: "old.ts",
	status: "renamed",
	binary: false,
	hunks: [{ file: "new.ts", index: 7, oldStart: 9, oldLines: 2, newStart: 2, newLines: 3, header: "", text: "" }],
};
function review() {
	return ReviewCoverage.compute(
		tree,
		"fixture",
		["lens"],
		[renamed],
		[
			{ lens: "lens", path: "new.ts", revision: "head", kind: "read", lines: [2, 4, 5] },
			{ lens: "lens", path: "old.ts", revision: "base", kind: "read", lines: [9, 10, 11] },
		],
		[{ file: "new.ts", line: 2, column: 1, endLine: 4, name: "changed", kind: "function" }],
	);
}
it("keeps renamed base paths and their distinct hunk starts and widths", () => {
	const files = review().toJSON().lenses[0]!.files;
	expect(files).toEqual([
		{
			path: "new.ts",
			revision: "head",
			status: "read",
			lines: [2, 4, 5].map((line) => ({ start: line, end: line })),
			searched: [],
			hunks: [7],
			functions: [{ name: "changed", line: 2 }],
		},
		{
			path: "old.ts",
			revision: "base",
			status: "read",
			lines: [9, 10, 11].map((line) => ({ start: line, end: line })),
			searched: [],
			hunks: [7],
			functions: [],
		},
	]);
	for (const [revision, path, line, expected] of [
		["head", "new.ts", 4, [7]],
		["head", "new.ts", 5, []],
		["base", "old.ts", 10, [7]],
		["base", "old.ts", 11, []],
	] as const) {
		const artifact = ReviewCoverage.compute(
			tree,
			"fixture",
			["lens"],
			[renamed],
			[{ lens: "lens", path, revision, kind: "read", lines: [line] }],
		);
		expect(artifact.toJSON().lenses[0]!.files.find((file) => file.revision === revision)?.hunks).toEqual(expected);
	}
});
it("refuses invalid review identities, nested fields, positions and ranges", () => {
	const state = review().toJSON(),
		lens = state.lenses[0]!,
		file = lens.files[0]!;
	for (const invalid of [
		{ ...state, tree: "invalid" },
		{ ...state, version: "" },
		{ ...state, extra: true },
		{ ...state, lenses: [{ ...lens, extra: true }] },
		{ ...state, lenses: [{ ...lens, files: [{ ...file, extra: true }] }] },
		...[
			{ lines: [{ start: 0, end: 1 }] },
			{ lines: [{ start: 2, end: 1 }] },
			{ lines: [{ start: 1, end: 2, extra: true }] },
			{ searched: [0] },
			{ hunks: [-1] },
			{ functions: [{ name: "x", line: 0 }] },
			{ functions: [{ name: "x", line: 1, extra: true }] },
		].map((change) => ({ ...state, lenses: [{ ...lens, files: [{ ...file, ...change }] }] })),
	])
		expect(() => ReviewCoverage.from(invalid)).toThrow("coverage");
});
it("refuses invalid test coverage identities and empty reasons", () => {
	const state = TestCoverage.unavailable(tree, "fixture").toJSON();
	for (const change of [{ tree: "invalid" }, { version: "" }, { reason: "" }, { extra: true }])
		expect(() => TestCoverage.from({ ...state, ...change })).toThrow("Invalid test coverage");
});
