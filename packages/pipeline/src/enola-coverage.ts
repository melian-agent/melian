import { dirname } from "node:path";
import {
	type CallGroundTruth,
	type CallPair,
	type EnolaFact,
	type EnolaFacts,
	type EnolaImpact,
	GraphCoverage,
	type ImportEdge,
	type SymbolSite,
} from "@melian-agent/core";
/** Ground truth matched against explicit facts and resolved upstream queries. */
export class EnolaCoverage {
	readonly #truth: CallGroundTruth;
	readonly #facts: EnolaFacts;
	readonly #answers: Map<string, EnolaImpact | undefined>;
	readonly #collisions: Set<string>;
	private constructor(truth: CallGroundTruth, facts: EnolaFacts, answers: Map<string, EnolaImpact | undefined>) {
		this.#truth = truth;
		this.#facts = facts;
		this.#answers = answers;
		const names = new Map<string, Set<string>>();
		for (const site of truth.symbols) {
			if (site.kind === "anonymous" || site.kind === "module") continue;
			const name = `${dirname(site.file)}.${site.name}`;
			const identities = names.get(name) ?? new Set<string>();
			identities.add(site.file);
			names.set(name, identities);
		}
		this.#collisions = new Set([...names].filter(([, identities]) => identities.size > 1).map(([name]) => name));
	}
	/** Resolves each unique callee through the upstream command, with a bounded worker count. */
	static async open(
		truth: CallGroundTruth,
		facts: EnolaFacts,
		query: (fact: EnolaFact) => Promise<EnolaImpact | undefined>,
		workers = 4,
	): Promise<EnolaCoverage> {
		const callees = new Map<string, EnolaFact>();
		for (const file of truth.files)
			for (const pair of file.pairs) for (const fact of facts.symbols(pair.callee)) callees.set(fact.id, fact);
		for (const file of truth.files)
			for (const edge of file.imports) {
				const fact = facts.file(edge.target);
				if (fact) callees.set(fact.id, fact);
			}
		const queue = [...callees.values()];
		const answers = new Map<string, EnolaImpact | undefined>();
		await Promise.all(
			Array.from({ length: Math.min(workers, queue.length) }, async () => {
				for (;;) {
					const fact = queue.pop();
					if (!fact) return;
					answers.set(fact.id, await query(fact));
				}
			}),
		);
		return new EnolaCoverage(truth, facts, answers);
	}
	#ambiguous(site: SymbolSite): boolean {
		return this.#collisions.has(`${dirname(site.file)}.${site.name}`);
	}
	#call(pair: CallPair, source: "combined" | "facts" | "impact"): string | undefined {
		if (/\.test\.[cm]?tsx?$/.test(pair.caller.file)) return "test file excluded";
		if (this.#ambiguous(pair.caller) || this.#ambiguous(pair.callee)) return "directory-scoped name collision";
		const callers = this.#facts.symbols(pair.caller),
			callees = this.#facts.symbols(pair.callee);
		if (
			callers.some((caller) =>
				callees.some(
					(callee) =>
						(source !== "impact" && this.#facts.calls(caller, callee)) ||
						(source !== "facts" && this.#answers.get(callee.id)?.calls(caller, callee)),
				),
			)
		)
			return undefined;
		if (pair.caller.kind === "anonymous" || pair.callee.kind === "anonymous")
			return "anonymous callback or function value";
		if (pair.callee.kind === "signature") return "interface or union method declaration";
		if (pair.throughThis) return "this method dispatch";
		if (pair.kind === "new") return "class construction";
		if (pair.kind === "tag") return "tagged template";
		if (!callees.length && pair.callee.name.includes(".#")) return "private method absent";
		if (!callers.length && pair.caller.name.includes(".#")) return "private method absent";
		if (
			(!callees.length && pair.callee.kind === "function" && pair.callee.name.includes(".")) ||
			(!callers.length && pair.caller.kind === "function" && pair.caller.name.includes("."))
		)
			return "nested named function value absent";
		if (!callees.length) return "callee declaration absent or differently located";
		if (!callers.length) return "caller declaration absent or differently located";
		if (source !== "facts" && callees.some((callee) => !this.#answers.get(callee.id)))
			return "query supplied no answer";
		if (source !== "facts" && callees.some((callee) => this.#answers.get(callee.id)?.truncated))
			return "query node cap";
		if (dirname(pair.caller.file) !== dirname(pair.callee.file)) return "cross-directory or barrel resolution";
		return "resolved declaration edge absent";
	}
	#import(file: string, edge: ImportEdge, source: "combined" | "facts" | "impact"): string | undefined {
		if (this.#facts.imports(file, edge.target)) return undefined;
		const target = this.#facts.file(edge.target);
		if (source !== "facts" && target && this.#answers.get(target.id)?.imports(file, edge.line, target))
			return undefined;
		if (/\.test\.[cm]?tsx?$/.test(file)) return "test file excluded";
		if (edge.kind === "dynamic") return "dynamic import";
		if (edge.kind === "re-export") return "re-export declaration";
		if (edge.typeOnly) return "type-only import";
		if (edge.target.endsWith(".json")) return "JSON import";
		if (edge.specifier.startsWith("@")) return "workspace package alias unresolved in facts";
		return "resolved import edge absent";
	}
	/** Computes facts-only or impact-resolved coverage with the same denominators. */
	measure(tree: string, version: string, source: "combined" | "facts" | "impact" = "combined"): GraphCoverage {
		return GraphCoverage.compute(tree, version, this.#truth, {
			call: (pair) => this.#call(pair, source),
			import: (file, edge) => this.#import(file, edge, source),
		});
	}
}
