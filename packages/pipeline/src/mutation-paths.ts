import { posix } from "node:path";
import type { Revision, UnmutatedFile } from "@melian-agent/core";

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

type Reason = { readonly why: string; readonly whatToDo: string };

export type MutationTargetReasons = Readonly<Record<"binary" | "signals" | "configuration" | "comma", Reason>>;

// The changed lines Stryker is asked about, and the changed production files it is not. The host check and
// `scripts/enumerate-mutants.mjs` both select through it, so the script cannot drop a file the check reports.
export class MutationTargets {
	readonly changed: Record<string, [number, number][]>;
	readonly aside: UnmutatedFile[];
	readonly binary: UnmutatedFile[];
	readonly notes: string[];

	private constructor(
		changed: Record<string, [number, number][]>,
		aside: UnmutatedFile[],
		binary: UnmutatedFile[],
		notes: string[],
	) {
		this.changed = changed;
		this.aside = aside;
		this.binary = binary;
		this.notes = notes;
	}

	// The reasons are passed in because the enumeration script runs under plain Node, which resolves
	// `@melian-agent/core` to a `dist` it has not built.
	static select(
		revision: Revision,
		isProduction: (path: string) => boolean,
		reasons: MutationTargetReasons,
	): MutationTargets {
		const changed: Record<string, [number, number][]> = {};
		const aside: UnmutatedFile[] = [];
		const notes: string[] = [];
		const setAside = (path: string, ranges: [number, number][], reason: Reason, note: string) => {
			notes.push(`${path} was not mutated: ${note}.`);
			aside.push({ path, ranges, ...reason });
		};
		for (const [path, ranges] of Object.entries(revision.diffLines())) {
			if (!isProduction(path)) continue;
			const kind = revision.files.find((file) => file.path === path)!.newKind;
			if (kind !== "file" && kind !== "executable") {
				const reason = nonRegularEntry(kind);
				setAside(path, ranges, reason, reason.why);
			} else if (signalFiles.has(path))
				setAside(path, ranges, reasons.signals, "it sends process signals; prove its guards with fakes");
			else if (configuration.test(path))
				setAside(path, ranges, reasons.configuration, "a tool loads a configuration file to run the mutants");
			else if (path.includes(",")) setAside(path, ranges, reasons.comma, "Stryker cannot take a path with a comma");
			else changed[path] = ranges;
		}
		const binary = revision.files
			.filter((file) => file.status !== "deleted" && (file.binary || file.percentEncoded === true))
			.filter((file) => isProduction(file.path))
			.map((file) => ({ path: file.path, ranges: [], ...reasons.binary }));
		return new MutationTargets(changed, aside, binary, notes);
	}

	get unmutated(): UnmutatedFile[] {
		return [...this.binary, ...this.aside];
	}

	get judges(): boolean {
		return Object.keys(this.changed).length > 0 || this.aside.length > 0 || this.binary.length > 0;
	}
}
