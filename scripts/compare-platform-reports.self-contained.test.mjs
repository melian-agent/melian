import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isCallExpression,
	isExportDeclaration,
	isExternalModuleReference,
	isIdentifier,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isStringLiteral,
	SyntaxKind,
} from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import { visibleText } from "../packages/core/src/render.ts";
import { HeadProgram } from "../packages/pipeline/src/compiler-graph.ts";
import { visible } from "./compare-platform-reports.mjs";

const script = join(import.meta.dirname, "compare-platform-reports.mjs");

// Every module a source names, as the compiler parses it. A specifier that is not a string literal reads as computed.
const imports = (text) => {
	const program = HeadProgram.open(new Map([["script.mjs", text]]));
	try {
		const found = [];
		const named = (node) => found.push(node !== undefined && isStringLiteral(node) ? node.text : "<computed>");
		const visit = (node) => {
			if (isImportDeclaration(node)) named(node.moduleSpecifier);
			if (isExportDeclaration(node) && node.moduleSpecifier !== undefined) named(node.moduleSpecifier);
			if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference))
				named(node.moduleReference.expression);
			if (
				isCallExpression(node) &&
				(node.expression.kind === SyntaxKind.ImportKeyword ||
					(isIdentifier(node.expression) && node.expression.text === "require"))
			)
				named(node.arguments[0]);
			node.forEachChild(visit);
		};
		visit(program.source("script.mjs"));
		return found;
	} finally {
		program.close();
	}
};

// The workflow, the script and the list are the whole of what judges a head on macOS, and all three draw a policy
// notice; a module the script imported from the workspace would judge it too, with none.
describe("the platform comparison is self-contained", () => {
	it("imports nothing but Node's own modules", () => {
		const outside = imports(readFileSync(script, "utf8")).filter((specifier) => !specifier.startsWith("node:"));
		expect(outside).toEqual([]);
	});

	it("finds a static, a re-exported, a dynamic, a computed and a required module", () => {
		const source = [
			'import { a } from "node:fs";',
			'import "../packages/core/src/render.ts";',
			'export { b } from "./b.mjs";',
			'const c = await import("./c.mjs");',
			"const d = await import(name);",
			'const e = require("./e.cjs");',
		].join("\n");
		expect(imports(source)).toEqual([
			"node:fs",
			"../packages/core/src/render.ts",
			"./b.mjs",
			"./c.mjs",
			"<computed>",
			"./e.cjs",
		]);
	});

	it("escapes exactly the code points core's visibleText escapes", () => {
		const differ = [];
		for (let point = 0; point <= 0x10ffff; point++) {
			const text = String.fromCodePoint(point);
			if (visible(text) !== visibleText(text)) differ.push(point.toString(16));
		}
		expect(differ).toEqual([]);
	});
});
