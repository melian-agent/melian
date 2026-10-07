import { dirname } from "node:path";
import {
	type CallGroundTruth,
	type CallPair,
	type EnolaFact,
	EnolaFacts,
	EnolaImpact,
	type ImportEdge,
	type SymbolSite,
} from "@melian-agent/core";
import { expect, it, vi } from "vitest";
import { EnolaCoverage } from "../src/enola-coverage.ts";

const caller: SymbolSite = { file: "src/a.ts", line: 1, column: 1, endLine: 3, name: "Caller", kind: "function" };
const callee: SymbolSite = { ...caller, file: "src/b.ts", name: "Callee" };
const pair: CallPair = { caller, callee, line: 2, expression: "Callee()", kind: "call", throughThis: false };
const edge: ImportEdge = { target: "src/b.ts", line: 1, specifier: "./b.ts", kind: "import", typeOnly: false };
function factsFor(sites: SymbolSite[]): EnolaFact[] {
	return sites.map((site) => ({
		id: site.name,
		kind: "symbol",
		name: `${dirname(site.file)}.${site.name}`,
		file: site.file,
		line: site.line,
	}));
}
function truthFor(
	pairs: CallPair[],
	imports: ImportEdge[] = [],
	symbols: SymbolSite[] = [caller, callee],
): CallGroundTruth {
	return {
		format_version: 1,
		compiler: "fixture",
		symbols,
		files: [{ path: pairs[0]?.caller.file ?? "src/a.ts", pairs, imports, external: 0, unresolved: 0 }],
	};
}
function emptyImpact(truncated = false): EnolaImpact {
	return EnolaImpact.parse(JSON.stringify({ target: "src.Callee", by_depth: {}, edges: [], stats: { truncated } }), 0);
}

it.each([
	["matching location", { file: caller.file, line: caller.line }, 1],
	["wrong file", { file: "src/other.ts", line: caller.line }, 0],
	["wrong start line", { file: caller.file, line: 99 }, 0],
	["missing location", {}, 0],
] satisfies [string, { file?: string; line?: number }, number][])(
	"measures impact calls with %s",
	async (_name, location, matchedCalls) => {
		const coverage = await EnolaCoverage.open(
			truthFor([pair]),
			EnolaFacts.parse(
				factsFor([caller, callee])
					.map((fact) => JSON.stringify(fact))
					.join("\n"),
			),
			async () =>
				EnolaImpact.parse(
					JSON.stringify({
						target: "src.Callee",
						by_depth: { "1": [{ name: "src.Caller", kind: "symbol", ...location }] },
						edges: [{ source: "src.Caller", target: "src.Callee", kind: "calls" }],
						stats: { truncated: false },
					}),
					0,
				),
		);
		const result = coverage.measure("a".repeat(40), "fixture", "impact").toJSON();
		expect(result.totals).toMatchObject({ calls: 1, matchedCalls });
		expect(result.files[0]?.gaps).toEqual(
			matchedCalls === 1
				? []
				: [expect.objectContaining({ kind: "call", cause: "resolved declaration edge absent" })],
		);
	},
);

it.each(["facts", "impact", "combined"] as const)(
	"does not borrow a nested helper's same-line call through %s",
	async (source) => {
		const helper = { ...caller, name: "helper", endLine: 1 };
		const nested = { ...helper, name: "outer.helper" };
		const target = { ...helper, name: "target" };
		const facts = EnolaFacts.parse(
			factsFor([helper, nested, target])
				.map((fact) =>
					JSON.stringify({
						...fact,
						...(fact.id === nested.name
							? { relations: [{ kind: "calls", target: "src.target", target_id: "target" }] }
							: {}),
					}),
				)
				.join("\n"),
		);
		const coverage = await EnolaCoverage.open(
			truthFor(
				[helper, nested].map((caller) => ({ ...pair, caller, callee: target, line: 1, expression: "target()" })),
				[],
				[helper, nested, target],
			),
			facts,
			async () =>
				EnolaImpact.parse(
					JSON.stringify({
						target: "src.target",
						by_depth: { "1": [{ name: "src.outer.helper", kind: "symbol", file: helper.file, line: 1 }] },
						edges: [{ source: "src.outer.helper", target: "src.target", kind: "calls" }],
						stats: { truncated: false },
					}),
					0,
				),
		);
		const result = coverage.measure("a".repeat(40), "fixture", source).toJSON();
		expect(result.totals).toMatchObject({ calls: 2, matchedCalls: 1 });
		expect(result.files[0]?.gaps).toHaveLength(1);
		expect(result.files[0]?.gaps[0]?.cause).toBe("resolved declaration edge absent");
		expect(facts.symbols(helper).map((fact) => fact.name)).toEqual(["src.helper"]);
		expect(facts.symbols(nested).map((fact) => fact.name)).toEqual(["src.outer.helper"]);
	},
);

it.each([
	["test file excluded", { caller: { ...caller, file: "src/a.test.ts" } }, [caller, callee]],
	["anonymous callback or function value", { caller: { ...caller, kind: "anonymous" } }, [callee]],
	["anonymous callback or function value", { callee: { ...callee, kind: "anonymous" } }, [caller]],
	["interface or union method declaration", { callee: { ...callee, kind: "signature" } }, [caller]],
	["this method dispatch", { throughThis: true }, [caller, callee]],
	["class construction", { kind: "new" }, [caller, callee]],
	["tagged template", { kind: "tag" }, [caller, callee]],
	["private method absent", { callee: { ...callee, name: "Box.#run" } }, [caller]],
	["private method absent", { caller: { ...caller, name: "Box.#run" } }, [callee]],
	["nested named function value absent", { callee: { ...callee, name: "outer.inner" } }, [caller]],
	["nested named function value absent", { caller: { ...caller, name: "outer.inner" } }, [callee]],
	["callee declaration absent or differently located", {}, [caller]],
	["caller declaration absent or differently located", {}, [callee]],
	[
		"cross-directory or barrel resolution",
		{ caller: { ...caller, file: "other/a.ts" } },
		[{ ...caller, file: "other/a.ts" }, callee],
	],
	["resolved declaration edge absent", {}, [caller, callee]],
] satisfies [string, Partial<CallPair>, SymbolSite[]][])(
	"diagnoses the missing call: %s",
	async (cause, override, present) => {
		const changedPair = { ...pair, ...override };
		const coverage = await EnolaCoverage.open(
			truthFor([changedPair]),
			EnolaFacts.parse(
				factsFor(present)
					.map((fact) => JSON.stringify(fact))
					.join("\n"),
			),
			async () => emptyImpact(),
		);
		const result = coverage.measure("a".repeat(40), "fixture").toJSON();
		expect(result.totals).toMatchObject({ calls: 1, matchedCalls: 0 });
		expect(result.files[0]?.gaps[0]?.cause).toBe(cause);
	},
);

it.each([
	["query supplied no answer", undefined],
	["query node cap", emptyImpact(true)],
] as const)("diagnoses %s only when impact answers participate", async (cause, answer) => {
	const coverage = await EnolaCoverage.open(
		truthFor([pair]),
		EnolaFacts.parse(
			factsFor([caller, callee])
				.map((fact) => JSON.stringify(fact))
				.join("\n"),
		),
		async () => answer,
	);
	expect(coverage.measure("a".repeat(40), "fixture").toJSON().files[0]?.gaps[0]?.cause).toBe(cause);
	expect(coverage.measure("a".repeat(40), "fixture", "facts").toJSON().files[0]?.gaps[0]?.cause).toBe(
		"resolved declaration edge absent",
	);
});

it.each(["caller", "callee"] as const)("rejects directory collisions at the %s", async (side) => {
	const duplicate = { ...pair[side], file: `src/duplicate-${side}.ts` };
	const coverage = await EnolaCoverage.open(
		truthFor([pair], [], [caller, callee, duplicate]),
		EnolaFacts.parse(
			factsFor([caller, callee])
				.map((fact) => JSON.stringify(fact))
				.join("\n"),
		),
		async () => emptyImpact(),
	);
	expect(coverage.measure("a".repeat(40), "fixture").toJSON().files[0]?.gaps[0]?.cause).toBe(
		"directory-scoped name collision",
	);
});

it.each(["anonymous", "module"] as const)("excludes %s sites from directory name collisions", async (kind) => {
	const coverage = await EnolaCoverage.open(
		truthFor([pair], [], [caller, callee, { ...callee, file: "src/duplicate.ts", kind }]),
		EnolaFacts.parse(
			factsFor([caller, callee])
				.map((fact) => JSON.stringify(fact))
				.join("\n"),
		),
		async () => emptyImpact(),
	);
	expect(coverage.measure("a".repeat(40), "fixture").toJSON().files[0]?.gaps[0]?.cause).toBe(
		"resolved declaration edge absent",
	);
});

it.each([
	["test file excluded", "src/a.test.ts", {}],
	["dynamic import", "src/a.ts", { kind: "dynamic" }],
	["re-export declaration", "src/a.ts", { kind: "re-export" }],
	["type-only import", "src/a.ts", { typeOnly: true }],
	["JSON import", "src/a.ts", { target: "src/b.json" }],
	["workspace package alias unresolved in facts", "src/a.ts", { specifier: "@tiny/b" }],
	["resolved import edge absent", "src/a.ts", {}],
] satisfies [string, string, Partial<ImportEdge>][])(
	"diagnoses the missing import: %s",
	async (cause, file, override) => {
		const truth = truthFor([], [{ ...edge, ...override }]);
		truth.files[0]!.path = file;
		const coverage = await EnolaCoverage.open(truth, EnolaFacts.parse(""), async () => undefined);
		expect(coverage.measure("a".repeat(40), "fixture").toJSON().files[0]?.gaps[0]?.cause).toBe(cause);
	},
);

it("queries each callee once and respects the worker bound", async () => {
	const sites = Array.from({ length: 6 }, (_, i) => ({ ...callee, name: `Callee${i}`, line: i + 1 }));
	const truth = truthFor(
		sites.flatMap((callee) => [
			{ ...pair, callee },
			{ ...pair, callee },
		]),
		[edge],
	);
	const facts = EnolaFacts.parse(
		[...factsFor([caller, ...sites]), { id: "file", kind: "file_ref", name: edge.target, file: edge.target }]
			.map((fact) => JSON.stringify(fact))
			.join("\n"),
	);
	let active = 0,
		maximum = 0;
	const query = vi.fn(async () => {
		maximum = Math.max(maximum, ++active);
		await new Promise((resolve) => setTimeout(resolve, 1));
		active--;
		return undefined;
	});
	await EnolaCoverage.open(truth, facts, query, 2);
	expect(query).toHaveBeenCalledTimes(7);
	expect(maximum).toBe(2);
	expect(active).toBe(0);
	query.mockClear();
	await EnolaCoverage.open(truthFor([]), EnolaFacts.parse(""), query);
	expect(query).not.toHaveBeenCalled();
});
