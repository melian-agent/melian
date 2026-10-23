import { type ChangedFile, type FileKind, mutationUnmutated, Revision } from "@melian-agent/core";
import { describe, expect, it, vi } from "vitest";
// The module builds its patterns and sets when it loads, so each test reloads it to put that code under the test. The
// import must be literal: Stryker picks test files through Vitest's `related` filter, which sees no `vi.importActual`.
async function load() {
	vi.resetModules();
	return await import("../src/mutation-paths.ts");
}

const scripts = /\.[cm]?[jt]sx?$/;

describe("mutation paths", () => {
	it("takes TypeScript with an optional c or m, and nothing else", async () => {
		const { typescript } = await load();
		for (const name of ["a.ts", "a.mts", "a.cts", "a.tsx"]) expect(typescript.test(name), name).toBe(true);
		for (const name of ["a.xts", "a.ts.txt", "a.js", "a.mjs", "a.cjs"])
			expect(typescript.test(name), name).toBe(false);
	});

	it("excludes declarations, tests and specs by their final extension", async () => {
		const { productionWithExtensions } = await load();
		for (const name of ["src/a.test.ts", "src/a.test.mts", "src/a.spec.cjs", "src/a.d.ts"])
			expect(productionWithExtensions(name, scripts), name).toBe(false);
		for (const name of ["src/a.test.ts.backup.ts", "src/a.test.xts.ts", "src/a.ts"])
			expect(productionWithExtensions(name, scripts), name).toBe(true);
	});

	it("names configuration files by their final extension", async () => {
		const { configuration } = await load();
		for (const name of ["a.config.ts", "a.config.mts", "a.config.cjs", "a.config.js"])
			expect(configuration.test(name), name).toBe(true);
		for (const name of ["a.config.xts", "a.config.ts.txt", "a.config.xs"])
			expect(configuration.test(name), name).toBe(false);
	});

	it("excludes every test, fixture and build directory", async () => {
		const { production } = await load();
		for (const folder of ["test", "tests", "__tests__", "__mocks__", "fixtures", "goldens", "dist", "node_modules"])
			expect(production(`src/${folder}/a.ts`), folder).toBe(false);
		expect(production("src/a.ts")).toBe(true);
	});

	it("lists the files that send process signals", async () => {
		const { signalFiles } = await load();
		expect([...signalFiles]).toEqual([
			"packages/core/src/git.ts",
			"packages/pipeline/src/cache-scratch.ts",
			"packages/pipeline/src/mutation-process.ts",
			"packages/pipeline/src/static.ts",
		]);
	});

	describe("the targets of a revision", () => {
		function changed(path: string, newKind: FileKind = "file", first = 2): ChangedFile {
			const hunk = { oldStart: first, oldLines: 1, newStart: first, newLines: 2, header: "", text: "" };
			return { status: "modified", path, newKind, binary: false, hunks: [{ ...hunk, file: path, index: 0 }] };
		}
		function unaddressable(path: string, more: Partial<ChangedFile> = {}): ChangedFile {
			return { status: "modified", path, binary: true, hunks: [], ...more };
		}
		const revisionOf = (...files: ChangedFile[]) => Revision.from({ base: "b", head: "h", files });

		it("mutates regular and executable production files and nothing else", async () => {
			const { MutationTargets, production } = await load();
			const targets = MutationTargets.select(
				revisionOf(changed("src/a.ts"), changed("src/b.ts", "executable", 5), changed("src/a.test.ts")),
				production,
				mutationUnmutated,
			);
			expect(targets.changed).toEqual({ "src/a.ts": [[2, 3]], "src/b.ts": [[5, 6]] });
			expect([targets.aside, targets.binary, targets.notes]).toEqual([[], [], []]);
		});

		it("sets aside each kind of file Stryker is not asked about, in diff order, with a note", async () => {
			const { MutationTargets, production } = await load();
			const targets = MutationTargets.select(
				revisionOf(
					changed("packages/pipeline/src/static.ts"),
					changed("src/a,b.ts"),
					changed("src/link.ts", "symlink"),
					changed("src/module.ts", "submodule"),
					changed("vitest.config.ts"),
				),
				production,
				mutationUnmutated,
			);
			expect(targets.changed).toEqual({});
			const symlink = "the head entry is symlink; only regular files are mutated";
			const submodule = "the head entry is submodule; only regular files are mutated";
			expect(targets.aside.map(({ path, ranges, why, whatToDo }) => [path, ranges, why, whatToDo])).toEqual([
				[
					"packages/pipeline/src/static.ts",
					[[2, 3]],
					mutationUnmutated.signals.why,
					mutationUnmutated.signals.whatToDo,
				],
				["src/a,b.ts", [[2, 3]], mutationUnmutated.comma.why, mutationUnmutated.comma.whatToDo],
				["src/link.ts", [[2, 3]], symlink, "Use a regular source file or prove the changed behaviour by hand."],
				["src/module.ts", [[2, 3]], submodule, "Use a regular source file or prove the changed behaviour by hand."],
				[
					"vitest.config.ts",
					[[2, 3]],
					mutationUnmutated.configuration.why,
					mutationUnmutated.configuration.whatToDo,
				],
			]);
			expect(targets.notes).toEqual([
				"packages/pipeline/src/static.ts was not mutated: it sends process signals; prove its guards with fakes.",
				"src/a,b.ts was not mutated: Stryker cannot take a path with a comma.",
				`src/link.ts was not mutated: ${symlink}.`,
				`src/module.ts was not mutated: ${submodule}.`,
				"vitest.config.ts was not mutated: a tool loads a configuration file to run the mutants.",
			]);
		});

		it("lists binary and percent-encoded production files still at head, before the files set aside", async () => {
			const { MutationTargets, production } = await load();
			const targets = MutationTargets.select(
				revisionOf(
					changed("src/a,b.ts"),
					unaddressable("src/blob.ts"),
					unaddressable("src/caf%E9.ts", { binary: false, percentEncoded: true }),
					unaddressable("src/gone.ts", { status: "deleted" }),
					unaddressable("src/blob.test.ts"),
					unaddressable("src/image.png"),
					unaddressable("src/mode.ts", { binary: false }),
				),
				production,
				mutationUnmutated,
			);
			expect(targets.binary).toEqual([
				{ path: "src/blob.ts", ranges: [], ...mutationUnmutated.binary },
				{ path: "src/caf%E9.ts", ranges: [], ...mutationUnmutated.binary },
			]);
			expect(targets.unmutated.map(({ path }) => path)).toEqual(["src/blob.ts", "src/caf%E9.ts", "src/a,b.ts"]);
			expect(targets.notes).toEqual(["src/a,b.ts was not mutated: Stryker cannot take a path with a comma."]);
		});

		it("reads production through the predicate it is given, for lines and binary files alike", async () => {
			const { MutationTargets, production, productionWithExtensions } = await load();
			const revision = revisionOf(changed("src/a.mjs"), unaddressable("src/b.mjs"));
			const typescriptOnly = MutationTargets.select(revision, production, mutationUnmutated);
			expect([typescriptOnly.changed, typescriptOnly.unmutated, typescriptOnly.judges]).toEqual([{}, [], false]);
			const javascript = MutationTargets.select(
				revision,
				(path) => productionWithExtensions(path, scripts),
				mutationUnmutated,
			);
			expect(javascript.changed).toEqual({ "src/a.mjs": [[2, 3]] });
			expect(javascript.binary.map(({ path }) => path)).toEqual(["src/b.mjs"]);
		});

		it("judges a revision with a mutable, a set-aside, or a binary production file, and no other", async () => {
			const { MutationTargets, production } = await load();
			const judges = (...files: ChangedFile[]) =>
				MutationTargets.select(revisionOf(...files), production, mutationUnmutated).judges;
			expect(judges(changed("src/a.ts"))).toBe(true);
			expect(judges(changed("vitest.config.ts"))).toBe(true);
			expect(judges(unaddressable("src/blob.ts"))).toBe(true);
			expect(judges(changed("src/a.test.ts"), unaddressable("src/gone.ts", { status: "deleted" }))).toBe(false);
		});
	});
});
