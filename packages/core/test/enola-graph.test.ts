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
