import { EnolaFacts, EnolaImpact, EnolaQueryError, type SymbolSite } from "@melian-agent/core";
import { expect, it } from "vitest";

const caller = { id: "a", name: "src.a", kind: "symbol", file: "src/a.ts", line: 1 };
const target = { id: "b", name: "src.b", kind: "symbol", file: "src/b.ts", line: 2 };
const report = {
	target: target.name,
	by_depth: {
		"1": [caller, { ...caller, name: "file", kind: "file_ref" }, { ...caller, name: "module", kind: "module" }],
	},
	edges: [{ source: caller.name, target: target.name, kind: "imports" }],
	stats: { truncated: false },
};
it("indexes only explicit imports and returns only symbol declarations", () => {
	const facts = EnolaFacts.parse(
		[
			{
				...caller,
				relations: [
					{ kind: "imports", target: "src/b.ts" },
					{ kind: "calls", target: "src/c.ts", target_id: target.id },
				],
			},
			{ ...caller, id: "file", name: caller.file, kind: "file_ref" },
		]
			.map((fact) => JSON.stringify(fact))
			.join("\n"),
	);
	expect(facts.imports(caller.file, "src/b.ts")).toBe(true);
	expect(facts.imports(caller.file, "src/c.ts")).toBe(false);
	expect(facts.inFile(caller.file)).toEqual([expect.objectContaining({ id: "a", kind: "symbol" })]);
	expect(facts.file(caller.file)).toEqual(expect.objectContaining({ id: "file", kind: "file_ref" }));
	expect(facts.file("absent.ts")).toBeUndefined();
	expect(facts.calls(facts.inFile(caller.file)[0]!, target)).toBe(true);
	expect(facts.calls(caller, target)).toBe(false);
	const site: SymbolSite = { file: caller.file, name: "a", line: 1, column: 1, endLine: 1, kind: "function" };
	expect(facts.symbols(site)).toHaveLength(1);
});
it("normalises an empty upstream report without normalising non-empty null edges", () => {
	expect(
		EnolaImpact.parse(JSON.stringify({ ...report, by_depth: {}, edges: null, total_dependents: 0 }), 0).toJSON()
			.edges,
	).toEqual([]);
	for (const invalid of [
		null,
		1,
		{ ...report, edges: null, total_dependents: 1 },
		{ ...report, by_depth: { "1": [{ ...caller, line: 0 }] } },
	])
		expect(() => EnolaImpact.parse(JSON.stringify(invalid), 0)).toThrow("Unreadable Enola impact report");
	expect(() => EnolaFacts.parse(JSON.stringify({ ...caller, line: 0 }))).toThrow("Unreadable Enola fact");
});
it("retains a bounded diagnostic and typed refusal for unsuccessful impact queries", () => {
	const text = "x".repeat(1500);
	expect(() => EnolaImpact.parse(text, 2)).toThrow(
		new EnolaQueryError("noAnswer", `Enola impact exited 2: ${"x".repeat(1024)}`),
	);
	try {
		EnolaImpact.parse(text, 2);
	} catch (error) {
		expect(error).toMatchObject({ code: "noAnswer", message: `Enola impact exited 2: ${"x".repeat(1024)}` });
	}
});
it("requires the importing declaration and a matching import edge", () => {
	const impact = EnolaImpact.parse(JSON.stringify(report), 0);
	expect(impact.imports(caller.file, caller.line, target)).toBe(true);
	for (const [file, line, destination] of [
		["wrong.ts", caller.line, target],
		[caller.file, 99, target],
		[caller.file, caller.line, { ...target, name: "src.other" }],
	] as const)
		expect(impact.imports(file, line, destination)).toBe(false);
	expect(
		EnolaImpact.parse(JSON.stringify({ ...report, edges: [{ ...report.edges[0], kind: "calls" }] }), 0).imports(
			caller.file,
			caller.line,
			target,
		),
	).toBe(false);
	expect(
		EnolaImpact.parse(
			JSON.stringify({ ...report, by_depth: { "1": [{ ...caller, name: "unrelated" }] } }),
			0,
		).imports(caller.file, caller.line, target),
	).toBe(false);
});
it("keeps symbol and file callers, excluding module nodes", () => {
	expect(
		EnolaImpact.parse(JSON.stringify(report), 0)
			.callers()
			.map((node) => node.name),
	).toEqual([caller.name, "file"]);
});

// A graph of declarations a.ts → b.ts → c.ts, where `src.c` is also named by a type use and by an unresolved call.
function graph() {
	const symbol = (id: string, name: string, file: string, line: number, relations: object[] = []) => ({
		id,
		name,
		kind: "symbol",
		file,
		line,
		relations,
	});
	return EnolaFacts.parse(
		[
			symbol("c", "src.c", "src/c.ts", 3, [{ kind: "declares", target: "src", target_id: "m" }]),
			symbol("b", "src.b", "src/b.ts", 2, [
				{ kind: "calls", target: "src.c", target_id: "c" },
				{ kind: "calls", target: "lib.missing" },
				{ kind: "calls", target: "lib.missing" },
				{ kind: "calls", target: "src.gone", target_id: "zz" },
				{ kind: "names", target: "src.c", target_id: "c" },
			]),
			symbol("a", "src.a", "src/a.ts", 1, [{ kind: "instantiates", target: "src.b", target_id: "b" }]),
			symbol("d", "src.d", "src/a.ts", 9, [{ kind: "calls", target: "src.c" }]),
			symbol("e", "other.c", "other/c.ts", 4),
			{ id: "m", name: "src", kind: "module", file: "src" },
		]
			.map((fact) => JSON.stringify(fact))
			.join("\n"),
	);
}

it("finds a declaration by its exact Enola name, or else by the end of its dotted name", () => {
	const facts = graph();
	expect(facts.definitions("src.c").map((fact) => fact.id)).toEqual(["c"]);
	expect(facts.definitions("c").map((fact) => fact.name)).toEqual(["other.c", "src.c"]);
	expect(facts.definitions("rc.c")).toEqual([]);
	expect(facts.definitions("src")).toEqual([]);
});

it("takes the exact name alone when a longer name also ends with it", () => {
	const facts = EnolaFacts.parse(
		[
			{ id: "c", name: "src.c", kind: "symbol", file: "src/c.ts", line: 1 },
			{ id: "n", name: "nested.src.c", kind: "symbol", file: "nested/src/c.ts", line: 1 },
		]
			.map((fact) => JSON.stringify(fact))
			.join("\n"),
	);
	expect(facts.definitions("src.c").map((fact) => fact.id)).toEqual(["c"]);
	expect(facts.definitions("c").map((fact) => fact.id)).toEqual(["n", "c"]);
});

it("lists every resolved edge to a declaration but its declares edges, and counts the unresolved ones", () => {
	const facts = graph();
	const [c] = facts.definitions("src.c");
	expect(facts.references(c!)).toEqual({
		references: [
			{ kind: "calls", fact: expect.objectContaining({ id: "b" }) },
			{ kind: "names", fact: expect.objectContaining({ id: "b" }) },
		],
		unresolved: 1,
	});
	const [module] = facts.toJSON().filter((fact) => fact.id === "m");
	expect(facts.references(module!)).toEqual({ references: [], unresolved: 0 });
	const [a] = facts.definitions("src.a");
	expect(facts.references(a!)).toEqual({ references: [], unresolved: 0 });
});

it("walks resolved calls and constructions outward to a depth and a node cap", () => {
	const facts = graph();
	const [c] = facts.definitions("src.c");
	const ids = (result: ReturnType<typeof facts.impact>) => result.reached.map(({ depth, fact }) => [depth, fact.id]);
	expect(ids(facts.impact(c!, 1, 10))).toEqual([[1, "b"]]);
	expect(facts.impact(c!, 2, 10)).toEqual({
		reached: [
			{ depth: 1, fact: expect.objectContaining({ id: "b" }) },
			{ depth: 2, fact: expect.objectContaining({ id: "a" }) },
		],
		truncated: false,
	});
	expect(facts.impact(c!, 2, 2).truncated).toBe(false);
	expect(facts.impact(c!, 2, 1)).toEqual({
		reached: [{ depth: 1, fact: expect.objectContaining({ id: "b" }) }],
		truncated: true,
	});
	expect(facts.impact(c!, 0, 10)).toEqual({ reached: [], truncated: false });
});

it("walks callers in file and line order, whatever order Enola wrote the facts and relations in", () => {
	const calls = (...ids: string[]) => ids.map((id) => ({ kind: "calls", target: `src.${id}`, target_id: id }));
	const facts = [
		{ id: "t", name: "src.t", kind: "symbol", file: "src/t.ts", line: 1 },
		{ id: "p", name: "src.p", kind: "symbol", file: "src/z.ts", line: 1, relations: calls("t") },
		{ id: "q", name: "src.q", kind: "symbol", file: "src/a.ts", line: 5, relations: calls("t", "t") },
		{ id: "r", name: "src.r", kind: "symbol", file: "src/a.ts", line: 2, relations: calls("q", "t") },
		{ id: "s", name: "src.s", kind: "symbol", file: "src/m.ts", line: 3, relations: calls("t") },
	];
	const permuted = facts.map((fact) => ({ ...fact, relations: [...(fact.relations ?? [])].reverse() })).reverse();
	for (const order of [facts, permuted]) {
		const graph = EnolaFacts.parse(order.map((fact) => JSON.stringify(fact)).join("\n"));
		const [t] = graph.definitions("src.t");
		const ids = (cap: number) => graph.impact(t!, 2, cap).reached.map(({ fact }) => fact.id);
		expect(ids(2)).toEqual(["r", "q"]);
		expect(ids(10)).toEqual(["r", "q", "s", "p"]);
		expect(graph.references(t!).references.map(({ fact }) => fact.id)).toEqual(["r", "q", "s", "p"]);
	}
});

it("walks callers that are top-level code, a file or a module, as it walks declarations", () => {
	const graph = EnolaFacts.parse(
		[
			{ id: "t", name: "src.t", kind: "symbol", file: "src/t.ts", line: 1 },
			{
				id: "f",
				name: "src/run.ts",
				kind: "file_ref",
				file: "src/run.ts",
				relations: [{ kind: "calls", target: "src.t", target_id: "t" }],
			},
			{
				id: "m",
				name: "lib",
				kind: "module",
				file: "lib",
				relations: [{ kind: "instantiates", target: "src.t", target_id: "t" }],
			},
			{
				id: "s",
				name: "src.s",
				kind: "symbol",
				file: "src/s.ts",
				line: 4,
				relations: [{ kind: "calls", target: "src/run.ts", target_id: "f" }],
			},
		]
			.map((fact) => JSON.stringify(fact))
			.join("\n"),
	);
	const [t] = graph.definitions("src.t");
	expect(graph.impact(t!, 2, 10).reached.map(({ depth, fact }) => [depth, fact.id])).toEqual([
		[1, "m"],
		[1, "f"],
		[2, "s"],
	]);
});

it("counts a declaration once when two edges reach it, and never walks back to the target", () => {
	const facts = EnolaFacts.parse(
		[
			{ id: "t", name: "src.t", kind: "symbol", relations: [{ kind: "calls", target: "src.s", target_id: "s" }] },
			{
				id: "s",
				name: "src.s",
				kind: "symbol",
				relations: [
					{ kind: "calls", target: "src.t", target_id: "t" },
					{ kind: "instantiates", target: "src.t", target_id: "t" },
				],
			},
		]
			.map((fact) => JSON.stringify(fact))
			.join("\n"),
	);
	const [t] = facts.definitions("src.t");
	expect(facts.impact(t!, 3, 10)).toEqual({
		reached: [{ depth: 1, fact: expect.objectContaining({ id: "s" }) }],
		truncated: false,
	});
});

it("lists what a declaration calls, resolved targets as facts and the rest once each by name", () => {
	const facts = graph();
	const [b] = facts.definitions("src.b");
	expect(facts.callees(b!)).toEqual({
		resolved: [{ kind: "calls", fact: expect.objectContaining({ id: "c" }) }],
		unresolved: ["lib.missing", "src.gone"],
	});
	const [a] = facts.definitions("src.a");
	expect(facts.callees(a!)).toEqual({
		resolved: [{ kind: "instantiates", fact: expect.objectContaining({ id: "b" }) }],
		unresolved: [],
	});
	const [c] = facts.definitions("src.c");
	expect(facts.callees(c!)).toEqual({ resolved: [], unresolved: [] });
});

it("sorts references by file, line and name, and callees' unresolved names, whatever order the facts come in", () => {
	const facts = EnolaFacts.parse(
		[
			{ id: "t", name: "src.t", kind: "symbol", file: "src/t.ts", line: 1 },
			{
				id: "z",
				name: "src.z",
				kind: "symbol",
				file: "src/z.ts",
				line: 1,
				relations: [{ kind: "calls", target: "src.t", target_id: "t" }],
			},
			{
				id: "a1",
				name: "src.a1",
				kind: "symbol",
				file: "src/a.ts",
				line: 20,
				relations: [{ kind: "calls", target: "src.t", target_id: "t" }],
			},
			{
				id: "ab",
				name: "src.ab",
				kind: "symbol",
				file: "src/a.ts-b",
				line: 1,
				relations: [{ kind: "calls", target: "src.t", target_id: "t" }],
			},
			{
				id: "a2",
				name: "src.a2",
				kind: "symbol",
				file: "src/a.ts",
				line: 3,
				relations: [
					{ kind: "names", target: "src.t", target_id: "t" },
					{ kind: "calls", target: "src.t", target_id: "t" },
				],
			},
			{
				id: "s",
				name: "src.s",
				kind: "symbol",
				relations: [
					{ kind: "calls", target: "lib.zeta" },
					{ kind: "calls", target: "lib.alpha" },
				],
			},
		]
			.map((fact) => JSON.stringify(fact))
			.join("\n"),
	);
	const [t] = facts.definitions("src.t");
	expect(facts.references(t!).references.map(({ kind, fact }) => `${fact.id} ${kind}`)).toEqual([
		"a2 calls",
		"a2 names",
		"a1 calls",
		"ab calls",
		"z calls",
	]);
	const [s] = facts.definitions("src.s");
	expect(facts.callees(s!).unresolved).toEqual(["lib.alpha", "lib.zeta"]);
});

it("counts no unresolved declares edge as a use", () => {
	const facts = EnolaFacts.parse(
		[
			{ id: "t", name: "src.t", kind: "symbol" },
			{ id: "m", name: "src", kind: "module", relations: [{ kind: "declares", target: "src.t" }] },
		]
			.map((fact) => JSON.stringify(fact))
			.join("\n"),
	);
	const [t] = facts.definitions("src.t");
	expect(facts.references(t!)).toEqual({ references: [], unresolved: 0 });
});

it("puts a reference with no file before every file, even one named with a capital", () => {
	const facts = EnolaFacts.parse(
		[
			{ id: "t", name: "src.t", kind: "symbol" },
			{
				id: "m",
				name: "src.m",
				kind: "symbol",
				file: "Makefile",
				line: 1,
				relations: [{ kind: "calls", target: "src.t", target_id: "t" }],
			},
			{ id: "n", name: "src.n", kind: "symbol", relations: [{ kind: "calls", target: "src.t", target_id: "t" }] },
		]
			.map((fact) => JSON.stringify(fact))
			.join("\n"),
	);
	const [t] = facts.definitions("src.t");
	expect(facts.references(t!).references.map(({ fact }) => fact.id)).toEqual(["n", "m"]);
});

it.each([
	["name", { id: "z", name: "a.same", file: "z.ts", line: 10 }, { id: "a", name: "z.same", file: "a.ts", line: 1 }],
	["file", { id: "z", file: "f0.ts", line: 10 }, { id: "a", file: "f1.ts", line: 1 }],
	["line", { id: "z", file: "f0.ts", line: 2 }, { id: "a", file: "f0.ts", line: 10 }],
	["ID", { id: "a", file: "f0.ts", line: 1 }, { id: "z", file: "f0.ts", line: 1 }],
	["absent file", { id: "z", line: 10 }, { id: "a", file: "A.ts", line: 1 }],
	["absent line", { id: "z", file: "f0.ts" }, { id: "a", file: "f0.ts", line: 1 }],
] as const)("orders declarations by %s in both fact orders", (_key, first, second) => {
	const expected = [first, second].map((fact) => ({ name: "src.same", kind: "symbol", ...fact }));
	for (const rows of [expected, [...expected].reverse()]) {
		const facts = EnolaFacts.parse(rows.map((fact) => JSON.stringify(fact)).join("\n"));
		expect(facts.definitions("same")).toEqual(expected);
	}
});
