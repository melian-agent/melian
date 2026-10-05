import { createHash } from "node:crypto";
import { type LedgerDraft, type LedgerRound, type LedgerStamp, Verdict, visibleText } from "@melian-agent/core";
import { GitHubError } from "./errors.ts";
import { code, marker, maxBodyLength, type RepositoryLinks, renderProse, renderReviewBody } from "./publication.ts";

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function details(title: string, body: string, collapsed = true): string {
	return `<details${collapsed ? "" : " open"}>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
}

function prose(text: string): string {
	return renderProse(visibleText(text));
}

function renderDiagram(text: string): string {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const name = "[A-Za-z][A-Za-z0-9_]{0,31}";
	const participant = new RegExp(`^participant ${name}(?: as [A-Za-z0-9 .,()-]+)?$`);
	const message = new RegExp(`^${name}(?:->>|-->>|->|-->)${name}: [A-Za-z0-9 .,()'-]+$`);
	if (lines[0] === "sequenceDiagram" && lines.slice(1).every((line) => participant.test(line) || message.test(line))) {
		return `\`\`\`mermaid\n${lines.map(visibleText).join("\n")}\n\`\`\``;
	}
	return prose(text);
}

/** The one comment Melian owns, projected from a verdict and durable publication rounds. */
export class Ledger {
	readonly stamp: LedgerStamp;
	private readonly draft: LedgerDraft;

	private constructor(draft: LedgerDraft, stamp: LedgerStamp) {
		this.draft = draft;
		this.stamp = stamp;
	}

	/** Builds the current ledger without reading the host or changing the record. */
	static from(
		verdict: Verdict,
		publication: LedgerDraft["publication"],
		options: Omit<LedgerDraft, "verdict" | "publication">,
	): Ledger {
		const current = publication.rounds.at(-1);
		if (current === undefined) throw new GitHubError("failed", "the ledger has no posted round");
		const stamp: LedgerStamp = {
			version: 1,
			base: current.base,
			head: current.head,
			round: current.round,
			verdict: verdict.fingerprint(),
			counts: {
				open: verdict.attention().length,
				blocking: verdict.findings.block.length,
				dismissed: verdict.dismissed.length,
			},
			lenses: current.details?.lenses.map(({ name, version }) => `${name}@${version}`) ?? [],
			plan: current.details === undefined ? null : digest(JSON.stringify(current.details)),
			projection: "",
		};
		const draft = { ...options, verdict, publication };
		const ledger = new Ledger(draft, stamp);
		stamp.projection = digest(
			[
				...ledger.sections({ web: "" }),
				...publication.rounds.slice(0, -1).map((round) => ledger.history(round, { web: "" })),
			].join("\n\n"),
		);
		return ledger;
	}

	/** Whether the host already carries this projection, including options and changed dismissal reasons. */
	diff(previous: LedgerStamp | undefined): boolean {
		return JSON.stringify(previous) !== JSON.stringify(this.stamp);
	}

	/** The signed, hidden JSON line read back after a write. Its hash is the marker's ID. */
	opening(): string {
		const json = JSON.stringify(this.stamp)
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e")
			.replace(/&/g, "\\u0026");
		return `${marker(this.stamp.head, "ledger", digest(json), this.draft.secret)}\n<!-- melian:stamp=${json} -->`;
	}

	/** The bounded comment, with earlier rounds shortened before the current round loses sections. */
	render(links: RepositoryLinks, limit = maxBodyLength): string {
		const opening = this.opening();
		const sections = this.sections(links);
		const history = this.draft.publication.rounds.slice(0, -1).map((round) => this.history(round, links));
		const assemble = () => [opening, ...sections, ...history].join("\n\n");
		if (assemble().length <= limit) return assemble();
		for (let i = 0; i < history.length; i++) {
			const round = this.draft.publication.rounds[i]!;
			history[i] = details(
				`Earlier round ${round.round} at ${round.head.slice(0, 12)}`,
				`${round.base.slice(0, 12)}..${round.head.slice(0, 12)}; ${round.verdict.status}. Details trimmed.`,
			);
			if (assemble().length <= limit) return assemble();
		}
		const note = `This ledger was cut to fit GitHub's limit; \`melian findings "#${this.draft.pullRequest}"\` lists all findings.`;
		while (history.length > 0) {
			history.shift();
			const body = [assemble(), note].join("\n\n");
			if (body.length <= limit) return body;
		}
		while (sections.length > 1) {
			sections.pop();
			const body = [assemble(), note].join("\n\n");
			if (body.length <= limit) return body;
		}
		const body = [opening, note].join("\n\n");
		if (body.length > limit) throw new GitHubError("failed", "the ledger stamp exceeds GitHub's body limit");
		return body;
	}

	private sections(links: RepositoryLinks): string[] {
		const { verdict, publication, walkthrough, pullRequest } = this.draft;
		const current = publication.rounds.at(-1)!;
		const summary = this.summary(current, verdict, links);
		const findings = verdict.attention().map((finding) => {
			const [start, end] = finding.lines();
			return `- ${prose(finding.properties.id)}: ${code(visibleText(finding.properties.path))}:${start}${end === start ? "" : `-${end}`} — ${code(visibleText(finding.ruleId))} (${finding.properties.resolution}): ${prose(finding.properties.explanation.what)}`;
		});
		const parts = [
			`## Melian review ledger\n\nBase ${current.base.slice(0, 12)}, head ${current.head.slice(0, 12)}, round ${current.round}.`,
			summary,
			...findings,
		];
		if (walkthrough.enabled) {
			const text = current.walkthrough;
			const body =
				text === undefined
					? "No walkthrough was stored for this review."
					: [
							prose(text.summary),
							[
								"| File | Summary |",
								"| --- | --- |",
								...text.files.map(
									({ path, summary }) =>
										`| ${code(visibleText(path)).replace(/\|/g, "\\|")} | ${prose(summary)} |`,
								),
							].join("\n"),
							...(text.note === undefined ? [] : [prose(text.note)]),
							...(walkthrough.diagrams && text.diagram !== undefined
								? [`Diagram (summary):\n\n${renderDiagram(text.diagram)}`]
								: []),
						].join("\n\n");
			parts.push(details("Walkthrough (summary, not a verdict)", body, walkthrough.collapsed));
		}
		parts.push(this.runDetails(current));
		parts.push("Verification outcomes: the verifier has not run; no verification outcomes are stored.");
		if (verdict.dismissed.length > 0)
			parts.push(
				[
					"### Dismissals",
					...verdict.dismissed.flatMap((finding) => [
						`- ${prose(finding.properties.id)} ${code(visibleText(finding.ruleId))}: ${prose(finding.properties.dismissal?.reason ?? "No reason stored.")}`,
						...(finding.properties.alsoReportedAs ?? []).flatMap((report) =>
							report.dismissal === undefined
								? []
								: [
										`- ${prose(report.id)} ${code(visibleText(report.ruleId))}: ${prose(report.dismissal.reason)}`,
									],
						),
					]),
				].join("\n\n"),
			);
		if (current.resolved.length > 0)
			parts.push(
				[
					"### Closed findings",
					...current.resolved.map(
						({ id, commit, reason }) =>
							`- ${prose(id)}: ${reason === undefined ? `Addressed in commit ${commit.slice(0, 12)}` : `Dismissed: ${prose(reason)}`}`,
					),
				].join("\n\n"),
			);
		parts.push(details("Prompt for agents", verdict.agentPrompt(`#${pullRequest}`)));
		return parts;
	}

	private summary(round: LedgerRound, verdict: Verdict, links: RepositoryLinks): string {
		const body = renderReviewBody(
			{
				pullRequest: this.draft.pullRequest,
				revision: round.head,
				base: round.base,
				fingerprint: verdict.fingerprint(),
				round: round.round,
				verdict,
				findings: [],
				stillOpen: 0,
				resolved: [],
				secret: this.draft.secret,
			},
			links,
		);
		return body.split("\n").slice(1).join("\n");
	}

	private runDetails(round: LedgerRound): string {
		const plan = round.details;
		const lines =
			plan === undefined
				? ["No run details were stored by the older reviewer."]
				: [
						`Policy: ${prose(plan.policy)}`,
						`Manifest: ${plan.manifest.map(prose).join(", ")}`,
						`Standards: ${plan.standards.map(prose).join(", ") || "none"}`,
						...plan.lenses.map(
							({ name, version, level, models, budget, usage }) =>
								`- ${prose(name)}@${prose(version)}, ${prose(level)}; route ${models.map(prose).join(", ")}; budgets ${prose(JSON.stringify(budget))}${usage === undefined ? "" : `; used ${usage.models.map(prose).join(", ")}, ${usage.tokens} tokens, $${usage.cost.toFixed(6)}`}`,
						),
					];
		return details("Run details", lines.join("\n\n"));
	}

	private history(round: LedgerRound, links: RepositoryLinks): string {
		const verdict = Verdict.from(round.verdict);
		const prior = new Ledger({ ...this.draft, verdict, publication: { rounds: [round] } }, this.stamp);
		return details(`Earlier round ${round.round} at ${round.head.slice(0, 12)}`, prior.sections(links).join("\n\n"));
	}
}

/** A ledger stamp read only after its enclosing marker has verified. */
export function parseLedgerStamp(body: string): LedgerStamp | undefined {
	const match = /^<!-- melian:stamp=(.*) -->$/.exec(body.split(/\r?\n/)[1] ?? "");
	if (match === null) return undefined;
	try {
		const value: unknown = JSON.parse(match[1]!);
		if (typeof value !== "object" || value === null) return undefined;
		const stamp = value as LedgerStamp;
		if (
			stamp.version !== 1 ||
			!/^[0-9a-f]{40,64}$/.test(stamp.base) ||
			!/^[0-9a-f]{40,64}$/.test(stamp.head) ||
			!Number.isSafeInteger(stamp.round) ||
			stamp.round < 1 ||
			!/^[0-9a-f]{16}$/.test(stamp.verdict) ||
			!/^[0-9a-f]{16}$/.test(stamp.projection) ||
			(stamp.plan !== null && !/^[0-9a-f]{16}$/.test(stamp.plan)) ||
			!Array.isArray(stamp.lenses) ||
			!stamp.lenses.every((lens) => typeof lens === "string") ||
			typeof stamp.counts !== "object" ||
			stamp.counts === null ||
			![stamp.counts.open, stamp.counts.blocking, stamp.counts.dismissed].every(
				(count) => Number.isSafeInteger(count) && count >= 0,
			)
		)
			return undefined;
		const opening = body.split(/\r?\n/)[0] ?? "";
		if (!opening.includes(`ledger=${digest(match[1]!)}`)) return undefined;
		return stamp;
	} catch {
		return undefined;
	}
}
