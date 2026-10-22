import { expect, it } from "vitest";
import {
	configuration,
	nonRegularEntry,
	production,
	productionWithExtensions,
	signalFiles,
	typescript,
} from "../packages/pipeline/src/mutation-paths.ts";

it("keeps static.mutation's TypeScript scope and permits JavaScript only on request", () => {
	for (const extension of ["ts", "tsx", "cts", "ctsx", "mts", "mtsx"]) {
		expect(production(`src/value.${extension}`)).toBe(true);
		expect(typescript.test(`value.${extension}`)).toBe(true);
		expect(configuration.test(`value.config.${extension}`)).toBe(true);
	}
	for (const extension of ["js", "jsx", "mjs", "cjs"]) {
		expect(configuration.test(`value.config.${extension}`)).toBe(true);
		expect(production(`src/value.${extension}`)).toBe(false);
		expect(productionWithExtensions(`src/value.${extension}`, /\.[cm]?[jt]sx?$/)).toBe(true);
	}
	for (const path of [
		"value.txt",
		"src/value.dts",
		"value.ts.txt",
		"valueXts",
		"src/value.d.ts",
		"src/value.test.ts",
		"src/value.spec.ts",
		"packages/evals/verifier/a.ts",
		"packages/evals/verifier/sub/a.ts",
	])
		expect(production(path)).toBe(false);
	for (const folder of ["test", "tests", "__tests__", "__mocks__", "fixtures", "goldens", "dist", "node_modules"])
		expect(production(`src/${folder}/value.ts`)).toBe(false);
	for (const path of [
		"tests.ts",
		"testable/value.ts",
		"packages/evals/verifier-other/a.ts",
		"src/value.tests.ts",
		"src/mytest.ts",
		"src/value.test.ts.backup.ts",
		"src/config.ts",
	])
		expect(production(path)).toBe(true);
	for (const extension of ["ts", "cts", "mts", "tsx", "mjs", "cjs", "jsx"])
		for (const suffix of ["d", "test", "spec"])
			expect(productionWithExtensions(`src/value.${suffix}.${extension}`, /\.[cm]?[jt]sx?$/)).toBe(false);
	expect(configuration.test("src/value.configXts")).toBe(false);
	expect(configuration.test("src/value.config.ts.txt")).toBe(false);
	expect(configuration.test("src/value.config.ts.backup.ts")).toBe(false);
	expect(signalFiles).toEqual(
		new Set([
			"packages/core/src/git.ts",
			"packages/pipeline/src/cache-scratch.ts",
			"packages/pipeline/src/mutation-process.ts",
			"packages/pipeline/src/static.ts",
		]),
	);
});

it.each(["symlink", "submodule", undefined])("names a non-regular %s head entry", (kind) => {
	expect(nonRegularEntry(kind)).toEqual({
		why: `the head entry is ${kind}; only regular files are mutated`,
		whatToDo: "Use a regular source file or prove the changed behaviour by hand.",
	});
});
