import { createHash } from "node:crypto";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { ChangedFile } from "./diff.ts";
import { CoverageError, type SymbolSite } from "./graph-coverage.ts";

const strict = { additionalProperties: false };
const identity = {
	format_version: Type.Literal(1),
	tree: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
	version: Type.String({ minLength: 1 }),
};
const range = Type.Object({ start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }) }, strict);
const reviewSchema = Type.Object(
	{
		...identity,
		lenses: Type.Array(
			Type.Object(
				{
					name: Type.String(),
					files: Type.Array(
						Type.Object(
							{
								path: Type.String(),
								revision: Type.Union([Type.Literal("head"), Type.Literal("base")]),
								status: Type.Union([
									Type.Literal("read"),
									Type.Literal("searched only"),
									Type.Literal("not read"),
								]),
								lines: Type.Array(range),
								searched: Type.Array(Type.Integer({ minimum: 1 })),
								hunks: Type.Array(Type.Integer({ minimum: 0 })),
								functions: Type.Array(
									Type.Object({ name: Type.String(), line: Type.Integer({ minimum: 1 }) }, strict),
								),
							},
							strict,
						),
					),
				},
				strict,
			),
		),
	},
	strict,
);
const testSchema = Type.Object(
	{ ...identity, status: Type.Literal("unavailable"), reason: Type.String({ minLength: 1 }) },
	strict,
);

/** Delivered tool output, rather than the range a model requested. */
export type ReviewRead = {
	lens: string;
	path: string;
	revision: "head" | "base";
	kind: "read" | "search";
	lines: number[];
};
/** Read and search coverage for each lens and changed file. */
export type ReviewCoverageState = Static<typeof reviewSchema>;
/** Test coverage remains unavailable until execution isolation exists. */
export type TestCoverageState = Static<typeof testSchema>;
/** Content identities stored beside check records. */
export type CoverageIds = { graph?: string; review?: string; test?: string };

/** Review coverage derived from delivered transcript results. */
export class ReviewCoverage {
	readonly #state: ReviewCoverageState;
	private constructor(state: ReviewCoverageState) {
		this.#state = state;
	}
	/** Records changed hunks and enclosing declarations touched by successful reads. */
	static compute(
		tree: string,
		version: string,
		lenses: readonly string[],
		files: readonly ChangedFile[],
		reads: readonly ReviewRead[],
		symbols: readonly SymbolSite[] = [],
	): ReviewCoverage {
		const state: ReviewCoverageState = {
			format_version: 1,
			tree,
			version,
			lenses: lenses.map((name) => ({
				name,
				files: files.flatMap((file) =>
					(["head", "base"] as const).map((revision) => {
						const path = revision === "base" ? (file.oldPath ?? file.path) : file.path;
						const delivered = reads.filter(
							(read) => read.lens === name && read.path === path && read.revision === revision,
						);
						const lines = [
							...new Set(delivered.filter((read) => read.kind === "read").flatMap((read) => read.lines)),
						].sort((a, b) => a - b);
						const searched = [
							...new Set(delivered.filter((read) => read.kind === "search").flatMap((read) => read.lines)),
						].sort((a, b) => a - b);
						const hunks = file.hunks
							.filter((hunk) => {
								const start = revision === "base" ? hunk.oldStart : hunk.newStart;
								const count = revision === "base" ? hunk.oldLines : hunk.newLines;
								return lines.some((line) => line >= start && line < start + count);
							})
							.map((hunk) => hunk.index);
						const functions =
							revision === "head"
								? symbols
										.filter(
											(symbol) =>
												symbol.file === path &&
												symbol.kind !== "module" &&
												lines.some((line) => line >= symbol.line && line <= symbol.endLine),
										)
										.map((symbol) => ({ name: symbol.name, line: symbol.line }))
								: [];
						return {
							path,
							revision,
							status: lines.length
								? ("read" as const)
								: searched.length
									? ("searched only" as const)
									: ("not read" as const),
							lines: lines.map((line) => ({ start: line, end: line })),
							searched,
							hunks,
							functions,
						};
					}),
				),
			})),
		};
		return ReviewCoverage.from(state);
	}
	/** Validates a stored artifact. */
	static from(stored: unknown): ReviewCoverage {
		if (!Value.Check(reviewSchema, stored)) throw new CoverageError("Invalid review coverage");
		for (const lens of stored.lenses)
			for (const file of lens.files) {
				if (
					file.lines.some((range) => range.end < range.start) ||
					file.status !== (file.lines.length ? "read" : file.searched.length ? "searched only" : "not read")
				)
					throw new CoverageError("Inconsistent review coverage");
			}
		return new ReviewCoverage(structuredClone(stored));
	}
	/** Hashes the stored content. */
	get id(): string {
		return createHash("sha256").update(JSON.stringify(this.#state)).digest("hex");
	}
	/** Returns a copy of the stored shape. */
	toJSON(): ReviewCoverageState {
		return structuredClone(this.#state);
	}
}

/** A test-coverage placeholder that never executes the head. */
export class TestCoverage {
	readonly #state: TestCoverageState;
	private constructor(state: TestCoverageState) {
		this.#state = state;
	}
	/** Records why test execution was withheld. */
	static unavailable(
		tree: string,
		version: string,
		reason = "Head tests require container isolation in milestone 3",
	): TestCoverage {
		return TestCoverage.from({ format_version: 1, tree, version, status: "unavailable", reason });
	}
	/** Validates a stored artifact. */
	static from(stored: unknown): TestCoverage {
		if (!Value.Check(testSchema, stored)) throw new CoverageError("Invalid test coverage");
		return new TestCoverage(structuredClone(stored));
	}
	/** Hashes the stored content. */
	get id(): string {
		return createHash("sha256").update(JSON.stringify(this.#state)).digest("hex");
	}
	/** Returns a copy of the stored shape. */
	toJSON(): TestCoverageState {
		return structuredClone(this.#state);
	}
}
