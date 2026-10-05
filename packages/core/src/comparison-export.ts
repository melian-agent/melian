import type { StoredComparisonAdjudication } from "./comparison-adjudication.ts";
import type { ComparisonEntry } from "./comparison-set.ts";
import { ComparisonSet, markdownText } from "./comparison-set.ts";

/** The markdown record of one changeset's comparison rounds; no output leaves the process here. */
export class ComparisonExport {
	private readonly entries: readonly ComparisonEntry[];
	private readonly target: string;
	private readonly url: string | undefined;

	constructor(entries: readonly ComparisonEntry[], target: string, url?: string) {
		this.entries = [...entries].sort(
			(a, b) =>
				(a.comparison.recordedAt() ?? "").localeCompare(b.comparison.recordedAt() ?? "") ||
				a.comparison.head.localeCompare(b.comparison.head),
		);
		this.target = target;
		this.url = url;
	}

	/** The whole comparison document for this changeset, including replacement history. */
	renderJson(): string {
		return `${JSON.stringify({ comparisons: Object.fromEntries(this.entries.map(({ comparison }) => [`${comparison.base}..${comparison.head}`, comparison.toJSON()])) }, null, 2)}\n`;
	}

	/** Today's comparison form: reviewers, lettered tables, notes, counts, and a differences heading. */
	render(): string {
		const reviewers = new Set<string>();
		for (const { comparison } of this.entries) {
			for (const reviewer of [
				...Object.values(comparison.importsBySource()).flatMap((each) => each.reviewers ?? []),
				...comparison.externalFindings().map((each) => each.reviewer),
			])
				reviewers.add(
					`${reviewer.name}${reviewer.version === undefined ? "" : ` ${reviewer.version}`}${reviewer.login === undefined ? "" : ` (${reviewer.login})`}`,
				);
		}
		const target = /^#\d+$/.test(this.target) ? `pull request ${this.target}` : this.target;
		const link = this.url === undefined ? markdownText(this.target) : `[${markdownText(this.target)}](${this.url})`;
		const out = [
			`# Comparison review: ${/^#\d+$/.test(this.target) ? `pull request ${link}` : markdownText(target)}\n\n`,
			`Target: ${link}.\n\n`,
			`Reviewers: ${[...reviewers].sort().map(markdownText).join("; ")}${reviewers.size === 0 ? "" : "; "}Melian's own review, in ${this.entries.length} stored ${this.entries.length === 1 ? "round" : "rounds"}.\n\n`,
			"Adjudication records valid, noise, or duplicate, with severity and a miss reason where required. Pending findings await the maintainer.\n\n",
		];
		let section = 0;
		for (const [round, { comparison, verdict }] of this.entries.entries()) {
			const groups = new Map<string, ReturnType<typeof comparison.externalFindings>>();
			for (const reviewer of Object.values(comparison.importsBySource()).flatMap((each) => each.reviewers ?? [])) {
				const name = `${reviewer.name}${reviewer.version === undefined ? "" : ` ${reviewer.version}`}${reviewer.login === undefined ? "" : ` (${reviewer.login})`}`;
				groups.set(name, []);
			}
			for (const finding of comparison.externalFindings()) {
				const name = `${finding.reviewer.name}${finding.reviewer.version === undefined ? "" : ` ${finding.reviewer.version}`}${finding.reviewer.login === undefined ? "" : ` (${finding.reviewer.login})`}`;
				groups.set(name, [...(groups.get(name) ?? []), finding]);
			}
			for (const [name, findings] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
				const letter = sectionLetter(section++);
				out.push(
					`## ${letter}. ${markdownText(name)}, round ${round + 1}\n\n`,
					`${findings.length} ${findings.length === 1 ? "finding" : "findings"} at ${comparison.head.slice(0, 12)}.\n\n`,
					tableHeader,
				);
				for (const [index, finding] of findings.entries()) {
					const judgement = comparison.judgement(finding.id);
					const adjudication = comparison.needsReason(finding.id)
						? "Pending: miss reason required"
						: this.judgement(judgement);
					const golden = comparison.adjudication(finding.id)?.current.golden;
					out.push(
						`| ${letter}${index + 1} | ${markdownText(name)} | ${markdownText(finding.where())} | ${markdownText(`${finding.title}: ${firstParagraph(finding.body)}`)} | ${adjudication} | ${markdownText(golden ?? "Not decided")} |\n`,
					);
				}
				out.push("\n");
			}
			const letter = sectionLetter(section++);
			const dismissed = new Set((verdict?.dismissed ?? []).map((finding) => finding.id));
			const findings = (verdict?.all() ?? []).filter((finding) => comparison.melianFindings().includes(finding.id));
			out.push(
				`## ${letter}. Melian review, round ${round + 1}\n\n`,
				`${findings.length} ${findings.length === 1 ? "finding" : "findings"} at ${comparison.head.slice(0, 12)}, verdict ${verdict?.status ?? "not recorded"}.\n\n`,
				tableHeader,
			);
			for (const [index, finding] of findings.entries()) {
				const [start, end] = finding.lines();
				const { explanation, path, source } = finding.properties;
				const judgement = comparison.judgement(finding.id);
				out.push(
					`| ${letter}${index + 1} | ${markdownText(`Melian, ${source.check}`)} | ${markdownText(`${path}:${start}${start === end ? "" : `-${end}`}`)} | ${markdownText(`${finding.ruleId}: ${firstParagraph(explanation.what)}${dismissed.has(finding.id) ? " (dismissed)" : ""}`)} | ${this.judgement(judgement)} | ${markdownText(judgement?.golden ?? "Not decided")} |\n`,
				);
			}
			out.push("\n");
		}
		out.push("## Maintainer decisions\n\n");
		let notes = 0;
		for (const { comparison } of this.entries) {
			for (const [id, { current }] of Object.entries(comparison.adjudications()).sort(([a], [b]) =>
				a.localeCompare(b),
			)) {
				if (current.note === undefined || current.note === "") continue;
				out.push(
					`- ${markdownText(current.note)} From ${id} at ${comparison.head.slice(0, 12)}, by ${markdownText(current.by.replace(/\s*<[^>]*>\s*$/, "").trim())} (${markdownText(current.at)}).\n`,
				);
				notes++;
			}
		}
		if (notes === 0) out.push("No maintainer notes recorded.\n");
		out.push(
			"\n## Counts\n\n",
			`${new ComparisonSet(this.entries).renderStats({ drain: false }).trimEnd().split("\n").map(markdownText).join("\n")}\n`,
			"\n## Differences\n\n",
		);
		for (const { comparison, verdict } of this.entries) {
			const matches = comparison.effectiveMatches();
			out.push(
				`At ${comparison.head.slice(0, 12)}: ${new Set(matches.map((each) => each.external)).size} matched external findings, ${comparison.externalOnly().length} external-only defects, ${comparison.melianOnly().length} Melian-only findings.\n\n`,
				`${comparison.render(verdict).trimEnd().split("\n").map(markdownText).join("\n")}\n\n`,
			);
		}
		return `${out.join("").trimEnd()}\n`;
	}

	private judgement(value: StoredComparisonAdjudication | undefined): string {
		if (value === undefined) return "Pending";
		return markdownText(
			[
				value.verdict === "duplicate" ? `duplicate of ${value.of ?? "not recorded"}` : value.verdict,
				value.severity,
				value.reason,
			]
				.filter((each) => each !== undefined)
				.join(", "),
		);
	}
}

const tableHeader = "| # | Reviewer | File | Summary | Adjudication | Golden |\n|---|---|---|---|---|---|\n";

function sectionLetter(index: number): string {
	let remaining = index + 1;
	let result = "";
	while (remaining > 0) {
		remaining--;
		result = String.fromCharCode(65 + (remaining % 26)) + result;
		remaining = Math.floor(remaining / 26);
	}
	return result;
}

function firstParagraph(body: string): string {
	const paragraph = body
		.trim()
		.split(/\r?\n[\t ]*\r?\n/, 1)[0]!
		.replace(/\s+/gu, " ");
	const points = [...paragraph];
	return points.length <= 300 ? paragraph : `${points.slice(0, 300).join("")}…`;
}
