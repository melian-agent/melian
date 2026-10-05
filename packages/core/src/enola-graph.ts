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
	private constructor(facts: EnolaFact[]) {
		this.#facts = facts;
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
		return this.#facts.filter(
			(fact) =>
				fact.file === site.file &&
				(site.kind === "module"
					? fact.kind === "file_ref"
					: fact.kind === "symbol" && fact.line === site.line && fact.name.endsWith(`.${site.name}`)),
		);
	}
	/** Returns symbol declarations in one changed file. */
	inFile(file: string): EnolaFact[] {
		return this.#facts
			.filter((fact) => fact.file === file && fact.kind === "symbol")
			.map((fact) => structuredClone(fact));
	}
	/** Returns a file node without treating a directory module as a file. */
	file(file: string): EnolaFact | undefined {
		return this.#facts.find((fact) => fact.kind === "file_ref" && fact.file === file && fact.name === file);
	}
	/** Tests an explicit contract import edge without inferring module aliases. */
	imports(file: string, target: string): boolean {
		return this.#facts.some(
			(fact) =>
				fact.file === file && fact.relations?.some((edge) => edge.kind === "imports" && edge.target === target),
		);
	}
	/** Tests an explicitly resolved call or construction edge. */
	calls(caller: EnolaFact, callee: EnolaFact): boolean {
		return (caller.relations ?? []).some(
			(edge) => ["calls", "instantiates"].includes(edge.kind) && edge.target_id === callee.id,
		);
	}
	/** Returns a copy of all contract facts. */
	toJSON(): EnolaFact[] {
		return structuredClone(this.#facts);
	}
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
		return Object.values(this.#state.by_depth)
			.flat()
			.some(
				(node) =>
					node.file === file &&
					node.line === line &&
					this.#state.edges.some(
						(edge) => edge.source === node.name && edge.target === target.name && edge.kind === "imports",
					),
			);
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
