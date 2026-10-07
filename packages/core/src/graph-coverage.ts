import { createHash } from "node:crypto";
import Type from "typebox";
import Value from "typebox/value";

const count = Type.Integer({ minimum: 0 });
const ratio = Type.Object(
	{ matched: count, total: count, ratio: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]) },
	{ additionalProperties: false },
);
const coverageSchema = Type.Object(
	{
		format_version: Type.Literal(1),
		tree: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
		version: Type.String(),
		compiler: Type.String(),
		files: Type.Array(
			Type.Object(
				{
					path: Type.String(),
					calls: ratio,
					imports: ratio,
					external: count,
					unresolved: count,
					gaps: Type.Array(
						Type.Object(
							{
								kind: Type.Union([Type.Literal("call"), Type.Literal("import")]),
								cause: Type.String(),
								detail: Type.String(),
								line: Type.Integer({ minimum: 1 }),
							},
							{ additionalProperties: false },
						),
					),
				},
				{ additionalProperties: false },
			),
		),
		totals: Type.Object(
			{
				calls: count,
				matchedCalls: count,
				imports: count,
				matchedImports: count,
				external: count,
				unresolved: count,
			},
			{ additionalProperties: false },
		),
		causes: Type.Record(Type.String(), count),
	},
	{ additionalProperties: false },
);
/** A coverage artifact is malformed or incompatible. */
export class CoverageError extends Error {
	readonly code = "invalidCoverage";
	constructor(message: string) {
		super(message);
		this.name = "CoverageError";
	}
}

/** A compiler declaration, identified by file and position rather than its short name. */
export type SymbolSite = {
	file: string;
	line: number;
	column: number;
	endLine: number;
	name: string;
	kind: "function" | "method" | "class" | "anonymous" | "module" | "signature";
};
/** One distinct caller/callee pair; line is a representative call site. */
export type CallPair = {
	caller: SymbolSite;
	callee: SymbolSite;
	line: number;
	kind: "call" | "new" | "tag";
	expression: string;
	throughThis: boolean;
};
/** One compiler-resolved import declaration. */
export type ImportEdge = {
	target: string;
	line: number;
	specifier: string;
	kind: "import" | "re-export" | "dynamic";
	typeOnly: boolean;
};
/** Compiler-resolved imports and calls, with external and unresolved calls kept separate. */
export type CallGroundTruth = {
	format_version: 1;
	compiler: string;
	files: { path: string; imports: ImportEdge[]; pairs: CallPair[]; external: number; unresolved: number }[];
	symbols: SymbolSite[];
};
/** One unmatched unit and its diagnosed cause. */
export type CoverageGap = { kind: "call" | "import"; cause: string; detail: string; line: number };
/** The file-level coverage artifact. A zero denominator has a null ratio. */
export type GraphCoverageState = {
	format_version: 1;
	tree: string;
	version: string;
	compiler: string;
	files: {
		path: string;
		calls: { matched: number; total: number; ratio: number | null };
		imports: { matched: number; total: number; ratio: number | null };
		external: number;
		unresolved: number;
		gaps: CoverageGap[];
	}[];
	totals: {
		calls: number;
		matchedCalls: number;
		imports: number;
		matchedImports: number;
		external: number;
		unresolved: number;
	};
	causes: Record<string, number>;
};
/** A measured graph comparison; matching remains the consumer's explicit contract. */
export class GraphCoverage {
	readonly #state: GraphCoverageState;
	private constructor(state: GraphCoverageState) {
		this.#state = state;
	}
	/** Measures each file, preserving every gap and its cause. */
	static compute(
		tree: string,
		version: string,
		truth: CallGroundTruth,
		matcher: { call(pair: CallPair): string | undefined; import(file: string, edge: ImportEdge): string | undefined },
	): GraphCoverage {
		const causes: Record<string, number> = {};
		const files = truth.files.map((file) => {
			const gaps: CoverageGap[] = [];
			for (const pair of file.pairs) {
				const cause = matcher.call(pair);
				if (cause)
					gaps.push({
						kind: "call",
						cause,
						detail: `${pair.caller.name}@${pair.caller.line}:${pair.caller.column} -> ${pair.callee.file}:${pair.callee.line}:${pair.callee.column} ${pair.callee.name} (${pair.expression})`,
						line: pair.line,
					});
			}
			for (const edge of file.imports) {
				const cause = matcher.import(file.path, edge);
				if (cause)
					gaps.push({
						kind: "import",
						cause,
						detail: `${edge.kind} ${edge.specifier} -> ${edge.target}`,
						line: edge.line,
					});
			}
			for (const gap of gaps) {
				const key = `${gap.kind}:${gap.cause}`;
				causes[key] = (causes[key] ?? 0) + 1;
			}
			const calls = file.pairs.length - gaps.filter((gap) => gap.kind === "call").length;
			const imports = file.imports.length - gaps.filter((gap) => gap.kind === "import").length;
			return {
				path: file.path,
				calls: {
					matched: calls,
					total: file.pairs.length,
					ratio: file.pairs.length ? calls / file.pairs.length : null,
				},
				imports: {
					matched: imports,
					total: file.imports.length,
					ratio: file.imports.length ? imports / file.imports.length : null,
				},
				external: file.external,
				unresolved: file.unresolved,
				gaps,
			};
		});
		const totals = files.reduce(
			(sum, file) => ({
				calls: sum.calls + file.calls.total,
				matchedCalls: sum.matchedCalls + file.calls.matched,
				imports: sum.imports + file.imports.total,
				matchedImports: sum.matchedImports + file.imports.matched,
				external: sum.external + file.external,
				unresolved: sum.unresolved + file.unresolved,
			}),
			{ calls: 0, matchedCalls: 0, imports: 0, matchedImports: 0, external: 0, unresolved: 0 },
		);
		return GraphCoverage.from({ format_version: 1, tree, version, compiler: truth.compiler, files, totals, causes });
	}
	/** Restores a computed artifact. */
	static from(state: unknown): GraphCoverage {
		if (!Value.Check(coverageSchema, state)) throw new CoverageError("Invalid graph coverage artifact");
		const names = new Set<string>();
		for (const file of state.files) {
			if (names.has(file.path)) throw new CoverageError("Duplicate coverage file");
			names.add(file.path);
			for (const [kind, metric] of [
				["call", file.calls],
				["import", file.imports],
			] as const) {
				if (
					metric.matched > metric.total ||
					metric.ratio !== (metric.total ? metric.matched / metric.total : null) ||
					metric.total - metric.matched !== file.gaps.filter((gap) => gap.kind === kind).length
				)
					throw new CoverageError("Inconsistent coverage counts");
			}
		}

		return new GraphCoverage(structuredClone(state));
	}
	/** A content ID for the check record. */
	get id(): string {
		return createHash("sha256").update(JSON.stringify(this.#state)).digest("hex");
	}
	/** Returns the stored artifact. */
	toJSON(): GraphCoverageState {
		return structuredClone(this.#state);
	}
	/** Renders the complete per-file table and every named gap. */
	render(): string {
		const ratio = (value: { matched: number; total: number; ratio: number | null }) =>
			`${value.matched}/${value.total} (${value.ratio === null ? "n/a" : `${(value.ratio * 100).toFixed(1)}%`})`;
		const rows = this.#state.files.map(
			(file) =>
				`| ${file.path} | ${ratio(file.calls)} | ${ratio(file.imports)} | ${file.external} | ${file.unresolved} |`,
		);
		const gaps = this.#state.files
			.filter((file) => file.gaps.length)
			.map(
				(file) =>
					`### ${file.path}\n\n${file.gaps.map((gap) => `- Line ${gap.line}, ${gap.kind}, ${gap.cause}: ${gap.detail.replaceAll("\n", "\\n")}`).join("\n")}`,
			);
		return `| File | Call pairs | Import edges | External calls | Unresolved calls |\n|---|---:|---:|---:|---:|\n${rows.join("\n")}\n\n## Named gaps\n\n${gaps.join("\n\n")}\n`;
	}
}
