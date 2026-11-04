import { dirname } from "node:path";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { SymbolSite } from "./graph-coverage.ts";

const nodeSchema = Type.Object({
	name: Type.String(),
	kind: Type.String(),
	file: Type.Optional(Type.String()),
	line: Type.Optional(Type.Integer({ minimum: 1 })),
});
const factSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	kind: Type.String(),
	file: Type.Optional(Type.String()),
	line: Type.Optional(Type.Integer({ minimum: 1 })),
	relations: Type.Optional(
		Type.Array(Type.Object({ kind: Type.String(), target: Type.String(), target_id: Type.Optional(Type.String()) })),
	),
});
/** An Enola contract fact. */
export type EnolaFact = Static<typeof factSchema>;
const impactSchema = Type.Object({
	target: Type.String(),
	by_depth: Type.Record(Type.String(), Type.Array(nodeSchema)),
	edges: Type.Array(Type.Object({ source: Type.String(), target: Type.String(), kind: Type.String() })),
	stats: Type.Object({ truncated: Type.Boolean() }),
});
/** The full impact report, retaining only fields Melian consumes. */
export type EnolaImpactState = Static<typeof impactSchema>;
/** An impact query supplied no answer or unreadable data. */
export class EnolaQueryError extends Error {
	readonly code: "noAnswer" | "invalidOutput";
	constructor(code: EnolaQueryError["code"], message: string) {
		super(message);
		this.name = "EnolaQueryError";
		this.code = code;
	}
}
/** Validated facts; names are data and never executable instructions. */
export class EnolaFacts {
	readonly #facts: EnolaFact[];
	readonly #byFile = new Map<string, EnolaFact[]>();
	readonly #imports = new Map<string, Set<string>>();
	#ids?: Map<string, EnolaFact>;
	#edges?: Map<string, { kind: string; source: EnolaFact }[]>;
	private constructor(facts: EnolaFact[]) {
		this.#facts = facts;
		for (const fact of facts) {
			if (fact.file === undefined) continue;
			const inFile = this.#byFile.get(fact.file) ?? [];
			inFile.push(fact);
			this.#byFile.set(fact.file, inFile);
			const targets = this.#imports.get(fact.file) ?? new Set<string>();
			for (const relation of fact.relations ?? []) if (relation.kind === "imports") targets.add(relation.target);
			this.#imports.set(fact.file, targets);
		}
	}
	/** Parses the receipt-versioned JSONL contract. */
	static parse(text: string): EnolaFacts {
		const facts = text
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const fact: unknown = JSON.parse(line);
				if (!Value.Check(factSchema, fact)) throw new EnolaQueryError("invalidOutput", "Unreadable Enola fact");
				return fact as EnolaFact;
			});
		return new EnolaFacts(facts);
	}
	/** Returns symbol facts with exact declaration identity; anonymous functions have no guessed name. */
	symbols(site: SymbolSite): EnolaFact[] {
		return (this.#byFile.get(site.file) ?? []).filter((fact) =>
			site.kind === "module"
				? fact.kind === "file_ref"
				: fact.kind === "symbol" && fact.line === site.line && fact.name === `${dirname(site.file)}.${site.name}`,
		);
	}
	/** Returns symbol declarations in one changed file. */
	inFile(file: string): EnolaFact[] {
		return (this.#byFile.get(file) ?? [])
			.filter((fact) => fact.kind === "symbol")
			.map((fact) => structuredClone(fact));
	}
	/** Returns a file node without treating a directory module as a file. */
	file(file: string): EnolaFact | undefined {
		return (this.#byFile.get(file) ?? []).find((fact) => fact.kind === "file_ref" && fact.name === file);
	}
	/** Tests an explicit contract import edge without inferring module aliases. */
	imports(file: string, target: string): boolean {
		return this.#imports.get(file)?.has(target) ?? false;
	}
	/** Tests an explicitly resolved call or construction edge. */
	calls(caller: EnolaFact, callee: EnolaFact): boolean {
		return (caller.relations ?? []).some(
			(edge) => ["calls", "instantiates"].includes(edge.kind) && edge.target_id === callee.id,
		);
	}
	/**
	 * The declarations a query names: the one whose Enola name is `name` exactly, or else every declaration whose name
	 * ends with `.name`, sorted by name, file, line and ID.
	 * Enola names declarations by directory and dotted path, such as `src.Store.open`.
	 */
	definitions(name: string): EnolaFact[] {
		const declarations = this.#facts.filter((fact) => fact.kind === "symbol");
		const exact = declarations.filter((fact) => fact.name === name);
		const found = exact.length > 0 ? exact : declarations.filter((fact) => fact.name.endsWith(`.${name}`));
		return found.map((fact) => structuredClone(fact)).sort(compareFacts);
	}
	/**
	 * Every fact with an edge Enola resolved to `target`, with the edge's kind, sorted by name, file, line and ID. `declares` edges
	 * are structure, not use, and are left out. `unresolved` counts the edges that name `target` but that Enola did not
	 * resolve to it, which a grep would have to settle.
	 */
	references(target: EnolaFact): { references: EnolaReference[]; unresolved: number } {
		const references = (this.#incoming().get(target.id) ?? [])
			.filter((edge) => edge.kind !== "declares")
			.map((edge) => ({ kind: edge.kind, fact: structuredClone(edge.source) }))
			.sort((a, b) => compareFacts(a.fact, b.fact) || compare(a.kind, b.kind));
		let unresolved = 0;
		for (const fact of this.#facts)
			for (const relation of fact.relations ?? [])
				if (relation.target_id === undefined && relation.kind !== "declares" && relation.target === target.name)
					unresolved++;
		return { references, unresolved };
	}
	/**
	 * The declarations that reach `target` through calls and constructions Enola resolved, nearest first, up to `depth`
	 * levels and `maxNodes` declarations. `truncated` says the node cap stopped the walk.
	 */
	impact(target: EnolaFact, depth: number, maxNodes: number): { reached: EnolaReach[]; truncated: boolean } {
		const incoming = this.#incoming();
		const seen = new Set([target.id]);
		const reached: EnolaReach[] = [];
		let frontier = [target.id];
		for (let level = 1; level <= depth && frontier.length > 0; level++) {
			const next: string[] = [];
			const edges = frontier
				.flatMap((id) => incoming.get(id) ?? [])
				.sort((a, b) => compareFacts(a.source, b.source) || compare(a.kind, b.kind));
			for (const edge of edges) {
				if (!callEdges.includes(edge.kind) || seen.has(edge.source.id)) continue;
				if (reached.length === maxNodes) return { reached, truncated: true };
				seen.add(edge.source.id);
				reached.push({ depth: level, fact: structuredClone(edge.source) });
				next.push(edge.source.id);
			}
			frontier = next;
		}
		return { reached, truncated: false };
	}
	/** What `source` calls or constructs: each target Enola resolved, as its fact, and each it did not, by the name it wrote. */
	callees(source: EnolaFact): { resolved: EnolaReference[]; unresolved: string[] } {
		const byId = this.#byId();
		const resolved: EnolaReference[] = [];
		const unresolved: string[] = [];
		for (const relation of source.relations ?? []) {
			if (!callEdges.includes(relation.kind)) continue;
			const target = relation.target_id === undefined ? undefined : byId.get(relation.target_id);
			if (target === undefined) unresolved.push(relation.target);
			else resolved.push({ kind: relation.kind, fact: structuredClone(target) });
		}
		resolved.sort((a, b) => compareFacts(a.fact, b.fact) || compare(a.kind, b.kind));
		return { resolved, unresolved: [...new Set(unresolved)].sort(compare) };
	}
	#byId(): Map<string, EnolaFact> {
		this.#ids ??= new Map(this.#facts.map((fact) => [fact.id, fact]));
		return this.#ids;
	}
	#incoming(): Map<string, { kind: string; source: EnolaFact }[]> {
		if (this.#edges === undefined) {
			this.#edges = new Map();
			for (const source of this.#facts)
				for (const relation of source.relations ?? []) {
					if (relation.target_id === undefined) continue;
					const edges = this.#edges.get(relation.target_id) ?? [];
					edges.push({ kind: relation.kind, source });
					this.#edges.set(relation.target_id, edges);
				}
			// Repeated edges describe one use; queries order the unique uses before applying their bounds.
			for (const [id, edges] of this.#edges) {
				const key = (edge: { kind: string; source: EnolaFact }) =>
					`${place(edge.source)}\0${edge.source.id}\0${edge.kind}`;
				const unique = new Map(edges.map((edge) => [key(edge), edge]));
				this.#edges.set(id, [...unique.values()]);
			}
		}
		return this.#edges;
	}
	/** Returns a copy of all contract facts. */
	toJSON(): EnolaFact[] {
		return structuredClone(this.#facts);
	}
}
/** A fact with an edge to or from the one a graph query named, and the edge's kind. */
export type EnolaReference = { kind: string; fact: EnolaFact };
/** A declaration that reaches the one a graph query named, and how many calls away it sits. */
export type EnolaReach = { depth: number; fact: EnolaFact };
const callEdges: readonly string[] = ["calls", "instantiates"];
function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
function compareFacts(a: EnolaFact, b: EnolaFact): number {
	return (
		compare(a.name, b.name) ||
		compare(a.file ?? "", b.file ?? "") ||
		(a.line ?? 0) - (b.line ?? 0) ||
		compare(a.id, b.id)
	);
}
function place(fact: EnolaFact): string {
	return `${fact.file ?? ""}\0${String(fact.line ?? 0).padStart(9, "0")}\0${fact.name}`;
}
/** A successful upstream query, never an exit-2 empty list. */
export class EnolaImpact {
	readonly #state: EnolaImpactState;
	private constructor(state: EnolaImpactState) {
		this.#state = state;
	}
	/** Requires exit zero and the full JSON contract. */
	static parse(text: string, exitCode: number): EnolaImpact {
		if (exitCode !== 0)
			throw new EnolaQueryError("noAnswer", `Enola impact exited ${exitCode}: ${text.slice(0, 1024)}`);
		const state: unknown = JSON.parse(text);
		if (typeof state === "object" && state !== null) {
			const fields = state as Record<string, unknown>;
			if (
				fields.edges === null &&
				fields.total_dependents === 0 &&
				typeof fields.by_depth === "object" &&
				fields.by_depth !== null &&
				Object.keys(fields.by_depth).length === 0
			)
				fields.edges = [];
		}
		if (!Value.Check(impactSchema, state))
			throw new EnolaQueryError("invalidOutput", "Unreadable Enola impact report");
		return new EnolaImpact(state as EnolaImpactState);
	}
	/** Tests a resolved call using the calling declaration and upstream's edge kind. */
	calls(caller: EnolaFact, callee: EnolaFact): boolean {
		return (
			Object.values(this.#state.by_depth)
				.flat()
				.some((node) => node.name === caller.name && node.file === caller.file && node.line === caller.line) &&
			this.#state.edges.some(
				(edge) =>
					edge.source === caller.name &&
					edge.target === callee.name &&
					["calls", "instantiates"].includes(edge.kind),
			)
		);
	}
	/** Tests a resolved import with the importing declaration's own file and line. */
	imports(file: string, line: number, target: EnolaFact): boolean {
		const sources = new Set(
			this.#state.edges
				.filter((edge) => edge.target === target.name && edge.kind === "imports")
				.map((edge) => edge.source),
		);
		return Object.values(this.#state.by_depth)
			.flat()
			.some((node) => node.file === file && node.line === line && sources.has(node.name));
	}
	/** Refuses a fuzzy resolution that selected another full name. */
	matchesTarget(name: string): boolean {
		return this.#state.target === name;
	}
	/** Returns upstream's dependents, including file_ref nodes. */
	callers(): EnolaImpactState["by_depth"][string] {
		return structuredClone(
			Object.values(this.#state.by_depth)
				.flat()
				.filter((node) => ["symbol", "file_ref"].includes(node.kind)),
		);
	}
	/** Whether upstream stopped at the node cap. */
	get truncated(): boolean {
		return this.#state.stats.truncated;
	}
	/** Returns the contract data. */
	toJSON(): EnolaImpactState {
		return structuredClone(this.#state);
	}
}
