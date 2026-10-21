import { posix } from "node:path";

// Production TypeScript is what the tests are there to hold; a test, a fixture, a golden or verifier corpus, built output,
// or a declaration file is not. A `.config.ts` is production: it can hold logic. It is not mutated, though, because a tool
// loads it to run the mutants, so a change to one is a file the run did not judge.
export const typescript = /\.[cm]?tsx?$/;
const notProduction = /\.(?:d|test|spec)\.[cm]?[jt]sx?$/;
export const configuration = /\.config\.[cm]?[jt]sx?$/;
const notProductionPrefix = "packages/evals/verifier/";
const notProductionDirectories: ReadonlySet<string> = new Set([
	"test",
	"tests",
	"__tests__",
	"__mocks__",
	"fixtures",
	"goldens",
	"dist",
	"node_modules",
]);

export function production(path: string): boolean {
	return productionWithExtensions(path, typescript);
}

export function productionWithExtensions(path: string, extensions: RegExp): boolean {
	return (
		extensions.test(path) &&
		!notProduction.test(path) &&
		!path.startsWith(notProductionPrefix) &&
		!posix
			.dirname(path)
			.split("/")
			.some((segment) => notProductionDirectories.has(segment))
	);
}

export const signalFiles = new Set([
	"packages/core/src/git.ts",
	"packages/pipeline/src/cache-scratch.ts",
	"packages/pipeline/src/mutation-process.ts",
	"packages/pipeline/src/static.ts",
]);

export function nonRegularEntry(kind: string | undefined): { why: string; whatToDo: string } {
	return {
		why: `the head entry is ${kind}; only regular files are mutated`,
		whatToDo: "Use a regular source file or prove the changed behaviour by hand.",
	};
}
