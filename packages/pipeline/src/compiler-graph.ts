import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallGroundTruth, CallPair, SymbolSite } from "@melian-agent/core";
import {
	isArrayLiteralExpression,
	isArrowFunction,
	isCallExpression,
	isClassDeclaration,
	isClassExpression,
	isConstructorDeclaration,
	isExportDeclaration,
	isExternalModuleReference,
	isFunctionDeclaration,
	isFunctionExpression,
	isGetAccessorDeclaration,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isNewExpression,
	isNoSubstitutionTemplateLiteral,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isSetAccessorDeclaration,
	isShorthandPropertyAssignment,
	isStringLiteral,
	isTaggedTemplateExpression,
	isVariableDeclaration,
	type Node,
	type SourceFile,
	SyntaxKind,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API, type Symbol as CompilerSymbol, type Project, type Snapshot, SymbolFlags } from "typescript/unstable/sync";

import { coverageCompiler } from "./coverage-identity.ts";

function callable(node: Node): boolean {
	return (
		isFunctionDeclaration(node) ||
		isFunctionExpression(node) ||
		isArrowFunction(node) ||
		isMethodDeclaration(node) ||
		node.kind === SyntaxKind.MethodSignature ||
		isConstructorDeclaration(node) ||
		isGetAccessorDeclaration(node) ||
		isSetAccessorDeclaration(node)
	);
}
function named(node: Node): string | undefined {
	const declaration = node as Node & { name?: Node };
	return declaration.name?.getText();
}
/**
 * TypeScript sources as text, held in a virtual file system and parsed by the same compiler as {@link CompilerGraph}.
 * The compiler sees names of its own choosing, each with the extension of the file it stands for, so a path an author
 * chose never reaches it and each file parses as the language it is.
 */
export class HeadProgram {
	readonly #api: API;
	readonly #snapshot: Snapshot;
	readonly #names: ReadonlyMap<string, string>;

	private constructor(api: API, snapshot: Snapshot, names: ReadonlyMap<string, string>) {
		this.#api = api;
		this.#snapshot = snapshot;
		this.#names = names;
	}

	/** Opens a program over `texts`, keyed by the path each text stands for. Throws when the compiler cannot start. */
	static open(texts: ReadonlyMap<string, string>): HeadProgram {
		const names = new Map<string, string>();
		const files: Record<string, string> = {};
		for (const [path, text] of texts) {
			const name = `/melian-head/f${names.size}${/\.(?:[cm]?ts|tsx)$/.exec(path)?.[0] ?? ".ts"}`;
			names.set(path, name);
			files[name] = text;
		}
		const api = new API({ cwd: "/melian-head", fs: createVirtualFileSystem(files) });
		try {
			return new HeadProgram(api, api.updateSnapshot({ openFiles: [...names.values()] }), names);
		} catch (error) {
			api.close();
			throw error;
		}
	}

	/** The syntax tree of the text opened under `path`, or `undefined` when none was or the compiler holds none. */
	source(path: string): SourceFile | undefined {
		const name = this.#names.get(path);
		return name === undefined
			? undefined
			: this.#snapshot.getDefaultProjectForFile(name)?.program.getSourceFile(name);
	}

	/** Releases the compiler process and snapshot. */
	close(): void {
		this.#snapshot.dispose();
		this.#api.close();
	}
}

/** Compiler ground truth from TypeScript 7's unstable synchronous API. */
export class CompilerGraph {
	readonly #root: string;
	readonly #canonical: string;
	readonly #api: API;
	readonly #paths = new Map<string, string>();
	readonly #imports = new Map<string, string[]>();
	readonly #snapshot: Snapshot;
	private constructor(root: string, api: API, snapshot: Snapshot) {
		this.#root = root;
		this.#canonical = process.platform === "linux" ? root : root.toLowerCase();
		this.#api = api;
		this.#snapshot = snapshot;
	}
	/** Opens the same root project as static.tsc, including its referenced projects. */
	static open(root: string, config = "tsconfig.json"): CompilerGraph {
		root = realpathSync(resolve(root));
		const api = new API({ cwd: root });
		try {
			return new CompilerGraph(root, api, api.updateSnapshot({ openProjects: [resolve(root, config)] }));
		} catch (error) {
			api.close();
			throw error;
		}
	}
	/** Releases the compiler process and snapshot. */
	close(): void {
		this.#snapshot.dispose();
		this.#api.close();
	}
	#path(path: string): string | undefined {
		const normal = path.replaceAll("\\", "/");
		if (
			!(process.platform === "linux" ? normal : normal.toLowerCase()).startsWith(`${this.#canonical}/`) ||
			normal.split("/").includes("node_modules") ||
			/\.d\.[cm]?ts$/.test(normal)
		)
			return undefined;
		return (
			this.#paths.get(process.platform === "linux" ? normal : normal.toLowerCase()) ??
			normal.slice(this.#root.length + 1)
		);
	}
	#site(node: Node): SymbolSite | undefined {
		const source = node.getSourceFile();
		const file = this.#path(source.fileName);
		if (!file) return undefined;
		const declaration =
			(isArrowFunction(node) || isFunctionExpression(node)) && isVariableDeclaration(node.parent)
				? node.parent
				: node;
		const position = source.getLineAndCharacterOfPosition(declaration.getStart(source));
		let name = named(declaration);
		if (isConstructorDeclaration(node)) name = "constructor";
		if (!name && (isArrowFunction(node) || isFunctionExpression(node)) && isVariableDeclaration(node.parent))
			name = named(node.parent);
		let kind: SymbolSite["kind"] =
			isClassDeclaration(node) || isClassExpression(node)
				? "class"
				: isMethodDeclaration(node) ||
						node.kind === SyntaxKind.MethodSignature ||
						isConstructorDeclaration(node) ||
						isGetAccessorDeclaration(node) ||
						isSetAccessorDeclaration(node)
					? "method"
					: "function";
		if (node.kind === SyntaxKind.MethodSignature) kind = "signature";
		if (!name) {
			name = `<anonymous@${position.line + 1}:${position.character + 1}>`;
			kind = "anonymous";
		}
		const parents: string[] = [];
		for (let parent = node.parent; parent && parent !== source; parent = parent.parent) {
			if (
				isClassDeclaration(parent) ||
				isClassExpression(parent) ||
				isInterfaceDeclaration(parent) ||
				callable(parent)
			) {
				const label = named(
					(isArrowFunction(parent) || isFunctionExpression(parent)) && isVariableDeclaration(parent.parent)
						? parent.parent
						: parent,
				);
				if (label) parents.unshift(label);
			}
		}
		return {
			file,
			line: position.line + 1,
			column: position.character + 1,
			endLine: source.getLineAndCharacterOfPosition(node.end).line + 1,
			name: [...parents, name].join("."),
			kind,
		};
	}
	#callee(node: Node, project: Project): SymbolSite | "external" | undefined {
		let symbol: CompilerSymbol | undefined = project.checker.getSymbolAtLocation(node);
		if (symbol && symbol.flags & SymbolFlags.Alias) symbol = project.checker.getAliasedSymbol(symbol);
		const declarations =
			symbol?.declarations
				.map((handle) => handle.resolve(project))
				.filter((value): value is Node => value !== undefined) ?? [];
		if (declarations.length && declarations.every((declaration) => !this.#path(declaration.getSourceFile().fileName)))
			return "external";
		const eligible = declarations.flatMap((declaration) => {
			if (
				(callable(declaration) &&
					!isGetAccessorDeclaration(declaration) &&
					!isSetAccessorDeclaration(declaration)) ||
				isClassDeclaration(declaration) ||
				isClassExpression(declaration)
			)
				return [declaration];
			if (
				isVariableDeclaration(declaration) &&
				declaration.initializer &&
				(isArrowFunction(declaration.initializer) || isFunctionExpression(declaration.initializer))
			)
				return [declaration.initializer];
			return [];
		});
		const declaration = eligible.find((value) => "body" in value && value.body !== undefined) ?? eligible[0];
		if (declaration) return this.#site(declaration) ?? "external";
		return undefined;
	}
	/** Reads literal Vitest setup paths without executing the head's configuration. Computed paths force a full-suite fallback. */
	setupFiles(config = "vitest.config.ts"): string[] {
		const modules = new Set(
			[config, ...this.#imports.keys()].filter(
				(path) => path === config || /(?:^|\/)(?:vitest|vite)(?:[.-][^/]*)?\.config\.[cm]?[jt]s$/.test(path),
			),
		);
		for (const path of modules) for (const target of this.#imports.get(path) ?? []) modules.add(target);
		const paths = new Set<string>();
		for (const project of this.#snapshot.getProjects()) {
			for (const name of project.program.getSourceFileNames()) {
				const path = this.#path(name);
				if (path === undefined || !modules.has(path)) continue;
				const source = project.program.getSourceFile(name);
				const visit = (node: Node): void => {
					if (isShorthandPropertyAssignment(node) && node.name.getText() === "setupFiles")
						throw new Error("Vitest setupFiles is computed");
					if (isPropertyAssignment(node) && node.name.getText().replace(/^['"]|['"]$/g, "") === "setupFiles") {
						const values = isArrayLiteralExpression(node.initializer)
							? node.initializer.elements
							: [node.initializer];
						for (const value of values) {
							if (!isStringLiteral(value) && !isNoSubstitutionTemplateLiteral(value))
								throw new Error("Vitest setupFiles is computed");
							const path = this.#path(resolve(this.#root, value.text));
							if (path === undefined) throw new Error("Vitest setup file is outside the repository");
							paths.add(path);
						}
					}
					node.forEachChild(visit);
				};
				source?.forEachChild(visit);
			}
		}
		return [...paths].sort();
	}

	/** Counts distinct caller/callee pairs, resolved repository imports, external calls, and unresolved calls. */
	read(options: { importsOnly?: boolean; maxFiles?: number; deadline?: number } = {}): CallGroundTruth {
		const visited = new Set<string>();
		const bound = (name: string) => {
			visited.add(name);
			if (visited.size > (options.maxFiles ?? Infinity) || Date.now() >= (options.deadline ?? Infinity))
				throw new Error("Compiler import graph reached its file or time bound");
		};
		const files = new Map<string, CallGroundTruth["files"][number]>();
		const symbols = new Map<string, SymbolSite>();
		for (const project of this.#snapshot.getProjects())
			for (const name of project.program.getSourceFileNames()) {
				if (!this.#path(name)) continue;
				bound(name);
				const physical = realpathSync(name);
				const path = this.#path(physical);
				if (path) this.#paths.set(process.platform === "linux" ? name : name.toLowerCase(), path);
			}
		for (const project of this.#snapshot.getProjects()) {
			for (const path of project.program.getSourceFileNames()) {
				const file = this.#path(path);
				if (!file || files.has(file)) continue;
				bound(path);
				const source = project.program.getSourceFile(path);
				if (!source || source.isDeclarationFile) continue;
				const truth: CallGroundTruth["files"][number] = {
					path: file,
					imports: [],
					pairs: [],
					external: 0,
					unresolved: 0,
				};
				const pairs = new Set<string>();
				const remember = (site: SymbolSite) => {
					symbols.set(`${site.file}:${site.line}:${site.column}:${site.name}`, site);
				};
				const visit = (node: Node, enclosing?: SymbolSite): void => {
					if (!options.importsOnly && callable(node)) {
						enclosing = this.#site(node);
						if (enclosing) remember(enclosing);
					}
					if (!options.importsOnly && (isClassDeclaration(node) || isClassExpression(node))) {
						const site = this.#site(node);
						if (site) remember(site);
					}
					let specifier: Node | undefined;
					let importKind: "import" | "re-export" | "dynamic" = "import";
					if (isImportDeclaration(node)) specifier = node.moduleSpecifier;
					if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference))
						specifier = node.moduleReference.expression;
					if (isExportDeclaration(node)) {
						specifier = node.moduleSpecifier;
						importKind = "re-export";
					}
					if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
						specifier = node.arguments[0];
						importKind = "dynamic";
					}
					if (specifier && (isStringLiteral(specifier) || isNoSubstitutionTemplateLiteral(specifier))) {
						const symbol = project.checker.getSymbolAtLocation(specifier);
						const target = symbol?.declarations.map((handle) => this.#path(handle.path)).find(Boolean);
						if (target)
							truth.imports.push({
								target,
								line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
								specifier: specifier.text,
								kind: importKind,
								typeOnly: isImportDeclaration(node)
									? node.importClause?.phaseModifier === SyntaxKind.TypeKeyword
									: isExportDeclaration(node) || isImportEqualsDeclaration(node)
										? node.isTypeOnly
										: false,
							});
					}
					if (
						!options.importsOnly &&
						(isCallExpression(node) || isNewExpression(node) || isTaggedTemplateExpression(node))
					) {
						const expression = isTaggedTemplateExpression(node) ? node.tag : node.expression;
						if (expression.kind !== SyntaxKind.ImportKeyword) {
							let callee = this.#callee(
								isPropertyAccessExpression(expression) ? expression.name : expression,
								project,
							);
							if (!callee) {
								const declaration = project.checker.getResolvedSignature(node)?.declaration?.resolve(project);
								if (declaration) {
									if (!this.#path(declaration.getSourceFile().fileName)) callee = "external";
									else if (callable(declaration)) callee = this.#site(declaration);
								}
							}
							if (callee === "external") truth.external++;
							else if (!callee) truth.unresolved++;
							else {
								remember(callee);
								const caller = enclosing ?? {
									file,
									line: 1,
									column: 1,
									endLine: source.getLineAndCharacterOfPosition(source.end).line + 1,
									name: "<module>",
									kind: "module" as const,
								};
								remember(caller);
								const key = JSON.stringify([
									caller.file,
									caller.line,
									caller.column,
									caller.name,
									callee.file,
									callee.line,
									callee.column,
									callee.name,
								]);
								if (!pairs.has(key)) {
									pairs.add(key);
									const pair: CallPair = {
										caller,
										callee,
										line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
										kind: isNewExpression(node) ? "new" : isTaggedTemplateExpression(node) ? "tag" : "call",
										expression: expression.getText(),
										throughThis:
											isPropertyAccessExpression(expression) &&
											expression.expression.kind === SyntaxKind.ThisKeyword,
									};
									truth.pairs.push(pair);
								}
							}
						}
					}
					node.forEachChild((child) => {
						visit(child, enclosing);
					});
				};
				visit(source);
				files.set(file, truth);
				this.#imports.set(
					file,
					truth.imports.map((edge) => edge.target),
				);
			}
		}
		return {
			format_version: 1,
			compiler: coverageCompiler,
			files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
			symbols: [...symbols.values()],
		};
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [root, output] = process.argv.slice(2);
	if (!root || !output) throw new Error("Expected repository root and output path");
	const compiler = CompilerGraph.open(root);
	try {
		writeFileSync(output, JSON.stringify(compiler.read()));
	} finally {
		compiler.close();
	}
}
