import { describe, expect, it, vi } from "vitest";
import type * as Paths from "../src/mutation-paths.ts";

// The module's patterns and sets are built when it loads. Loading it inside each test gives Stryker per-test coverage of
// them; a load at import time counts as outside any test, and Stryker then runs only an unrelated test that reloads it.
async function load(): Promise<typeof Paths> {
	vi.resetModules();
	return vi.importActual<typeof Paths>("../src/mutation-paths.ts");
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
});
