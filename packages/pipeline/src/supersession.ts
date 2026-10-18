import {
	type CheckReport,
	capSnippet,
	configLookup,
	Finding,
	type GuardrailInput,
	maxEvidenceLines,
	openSource,
	snippetHash,
} from "@melian-agent/core";
import { DecisionFile, DecisionFiles, decisionPathPattern } from "@melian-agent/decisions";

export class SupersessionReview {
	readonly #input: GuardrailInput;

	constructor(input: GuardrailInput) {
		this.#input = input;
	}

	async report(): Promise<CheckReport> {
		const { repoRoot, revision, source } = this.#input;
		const paths = revision.files
			.flatMap((file) => (file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]))
			.filter((path) => decisionPathPattern.test(path));
		const configFor = configLookup(repoRoot, source);
		const enabled = await Promise.all(
			paths.map(async (path) => (await configFor(path)).guardrails["supersession-drop"].enabled),
		);
		if (!enabled.some((value) => value)) return { findings: [], notes: [] };
		const head = (await DecisionFiles.load(repoRoot, revision.head)).files();
		const byPath = new Map(head.map((file) => [file.path, file]));
		const base = await openSource(repoRoot, { kind: "revision", commit: revision.base });
		const findings: Finding[] = [];
		for (const successor of head) {
			const changed = revision.files.find((file) => file.path === successor.path);
			if (changed === undefined) continue;
			if (!(await configFor(successor.path)).guardrails["supersession-drop"].enabled) continue;
			const previousPath = changed.oldPath ?? successor.path;
			const previousText = await base.readText(previousPath, 256 * 1024);
			const previous = previousText === undefined ? [] : DecisionFile.parse(previousPath, previousText).declarations;
			const reported = new Set<string>();
			for (const declaration of successor.declarations) {
				if (declaration.kind !== "Supersedes") continue;
				for (const target of declaration.targets) {
					if (
						reported.has(target) ||
						previous.some((old) => old.targets.includes(target) && old.text === declaration.text)
					)
						continue;
					reported.add(target);
					const renamed = revision.files.find((file) => file.path === target);
					let baseline = byPath.get(target)!;
					let at: "head" | "base" = "head";
					for (const path of new Set([renamed?.oldPath ?? target, target])) {
						const text = await base.readText(path, 256 * 1024);
						if (text === undefined) continue;
						baseline = DecisionFile.parse(path, text);
						at = "base";
						break;
					}
					const clauses = baseline.clauses();
					const missing = baseline.uncarriedBy(successor);
					const first = missing[0];
					const detail =
						clauses.length === 0
							? "The target has no comparable prose."
							: capSnippet(
									missing
										.map((clause) => `${baseline.path}:${clause.line}-${clause.endLine}: ${clause.text}`)
										.join("\n"),
								);
					findings.push(
						Finding.create({
							rule: "guardrail/supersession-drop",
							message: `Supersedes retires ${target}; restate what survives.`,
							file: successor.path,
							startLine: declaration.sourceLine,
							discriminator: target,
							trigger: { file: successor.path, index: 0, hash: snippetHash(declaration.text) },
							cause: "introduced",
							severity: "P3",
							source: { check: "guardrails" },
							...(first === undefined
								? {}
								: {
										evidence: [
											{
												file: baseline.path,
												startLine: first.line,
												endLine: Math.min(first.endLine, first.line + maxEvidenceLines - 1),
												role: "context" as const,
												revision: at,
												snippet: capSnippet(first.text),
											},
										],
									}),
							explanation: {
								what: `This declaration retires the whole decision ${target}.`,
								whyHere: `${missing.length} uncarried clause(s) from ${baseline.path}. ${detail}`,
								whatToDo:
									"Restate every surviving clause, or use Amends: <target link>, <scope> for a narrow change. This notice compares only the direct target; earlier losses in a chain remain unaudited.",
							},
						}),
					);
				}
			}
		}
		return { findings, notes: [] };
	}
}
