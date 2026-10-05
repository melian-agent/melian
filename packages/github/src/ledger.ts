import { createHash, createHmac } from "node:crypto";
import {
	type LedgerDraft,
	type LedgerHistory,
	type LedgerRound,
	type LedgerStamp as StoredLedgerStamp,
	Verdict,
	visibleText,
} from "@melian-agent/core";
import { GitHubError } from "./errors.ts";
import {
	code,
	inline,
	marker,
	maxBodyLength,
	parseMarker,
	type RepositoryLinks,
	renderReviewBody,
} from "./publication.ts";

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function details(title: string, body: string, collapsed = true): string {
	return `<details${collapsed ? "" : " open"}>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
}

function prose(text: string): string {
	return inline(text);
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
	readonly stamp: StoredLedgerStamp;
	private readonly draft: LedgerDraft;

	private constructor(draft: LedgerDraft, stamp: StoredLedgerStamp) {
		this.draft = draft;
		this.stamp = stamp;
	}

	/** Reads a stamp, only after its enclosing marker has verified; checks its digest against the marker and exact visible body. */
	static readStamp(body: string): StoredLedgerStamp | undefined {
		const match = /^<!-- melian:stamp=(.*) -->$/.exec(body.split(/\r?\n/)[1] ?? "");
		if (match === null) return undefined;
		try {
			const value: unknown = JSON.parse(match[1]!);
			if (typeof value !== "object" || value === null) return undefined;
			const stamp = value as StoredLedgerStamp;
			if (
				stamp.version !== 1 ||
				typeof stamp.base !== "string" ||
				!/^[0-9a-f]{40,64}$/.test(stamp.base) ||
				typeof stamp.head !== "string" ||
				!/^[0-9a-f]{40,64}$/.test(stamp.head) ||
				!Number.isSafeInteger(stamp.round) ||
				stamp.round < 1 ||
				typeof stamp.verdict !== "string" ||
				!/^[0-9a-f]{16}$/.test(stamp.verdict) ||
				typeof stamp.projection !== "string" ||
				!/^[0-9a-f]{16}$/.test(stamp.projection) ||
				(stamp.plan !== null && (typeof stamp.plan !== "string" || !/^[0-9a-f]{16}$/.test(stamp.plan))) ||
				!Array.isArray(stamp.lenses) ||
				!stamp.lenses.every((lens) => typeof lens === "string") ||
				typeof stamp.counts !== "object" ||
				stamp.counts === null ||
				![stamp.counts.open, stamp.counts.blocking, stamp.counts.dismissed].every(
					(count) => Number.isSafeInteger(count) && count >= 0,
				)
			)
				return undefined;
			const opening = parseMarker(body.split(/\r?\n/)[0] ?? "");
			if (opening?.kind !== "ledger" || opening.id !== digest(match[1]!) || opening.revision !== stamp.head)
				return undefined;
			const visible = body.slice(body.indexOf("\n", body.indexOf("\n") + 1) + 1);
			if (!visible.startsWith("\n") || digest(visible.slice(1)) !== stamp.projection) return undefined;
			return stamp;
		} catch {
			return undefined;
		}
	}

	/** Builds the current ledger without reading the host or changing the record. */
	static from(
		verdict: Verdict,
		publication: LedgerDraft["publication"],
		options: Omit<LedgerDraft, "verdict" | "publication">,
	): Ledger {
		const current = publication.rounds.at(-1);
		if (current === undefined || !("verdict" in current))
			throw new GitHubError("failed", "the ledger has no posted round");
		const stamp: StoredLedgerStamp = {
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
			projection: digest(""),
		};
		const draft = { ...options, verdict, publication };
		const ledger = new Ledger(draft, stamp);
		ledger.render({ web: "" });
		return ledger;
	}

	/** Whether this projection differs from the host stamp, including options and dismissal reasons. */
	diff(previous: StoredLedgerStamp | undefined): boolean {
		return JSON.stringify(previous) !== JSON.stringify(this.stamp);
	}

	/** The signed, hidden JSON line read back after a write. Its hash is the marker's ID. */
	opening(): string {
		const json = JSON.stringify(this.stamp)
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e")
			.replace(/&/g, "\\u0026")
			.replace(/\u2028/g, "\\u2028")
			.replace(/\u2029/g, "\\u2029");
		return `${marker(this.stamp.head, "ledger", digest(json), this.draft.secret)}\n<!-- melian:stamp=${json} -->`;
	}

	/** The bounded comment, with earlier rounds shortened before the current round loses sections. */
	render(links: RepositoryLinks, limit = maxBodyLength): string {
		const sections = this.sections(links);
		const history = this.draft.publication.rounds.slice(0, -1).map((round) => this.history(round, links));
		const note = `This ledger was cut to fit GitHub's limit; \`melian findings "#${this.draft.pullRequest}"\` lists all findings.`;
		let cut = false;
		const projection = () => [...sections, ...history, ...(cut ? [note] : [])].join("\n\n");
		const fits = () => this.opening().length + 2 + projection().length <= limit;
		for (let i = 0; !fits() && i < history.length; i++) {
			const round = this.draft.publication.rounds[i]!;
			if (!("verdict" in round)) continue;
			history[i] = details(
				`Earlier round ${round.round} at ${round.head.slice(0, 12)}`,
				`${round.base.slice(0, 12)}..${round.head.slice(0, 12)}; ${round.verdict.status}. Details trimmed.`,
			);
			cut = true;
		}
		while (!fits() && history.length > 0) {
			history.shift();
			cut = true;
		}
		if (!fits()) {
			const walkthrough = sections.findIndex((part) => part.includes("<summary>Walkthrough"));
			if (walkthrough >= 0) sections.splice(walkthrough, 1);
			cut = true;
		}
		while (!fits() && sections.length > 0) {
			sections.pop();
			cut = true;
		}
		if (!fits()) throw new GitHubError("failed", "the ledger stamp exceeds GitHub's body limit");
		this.stamp.projection = digest(projection());
		return `${this.opening()}\n\n${projection()}`;
	}

	private sections(links: RepositoryLinks, withPrompt = true): string[] {
		const { verdict, publication, walkthrough, pullRequest } = this.draft;
		const current = publication.rounds.at(-1)! as LedgerRound;
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
					? prose(current.walkthroughNote ?? "No walkthrough was stored for this review.")
					: [
							prose(text.summary.slice(0, 4000)),
							[
								"| File | Summary |",
								"| --- | --- |",
								...text.files
									.slice(0, 100)
									.map(
										({ path, summary }) =>
											`| ${code(visibleText(path)).replace(/\|/g, "\\|")} | ${prose(summary.slice(0, 2000))} |`,
									),
							].join("\n"),
							...(walkthrough.diagrams && text.diagram !== undefined
								? [`Diagram (summary):\n\n${renderDiagram(text.diagram.slice(0, 4000))}`]
								: []),
						].join("\n\n");
			const bounded =
				body.length <= 12_000
					? body
					: `${prose(text?.summary.slice(0, 4000) ?? "No walkthrough available.").slice(0, 11_900)}\n\nWalkthrough details trimmed.`;
			parts.push(details("Walkthrough (summary, not a verdict)", bounded, walkthrough.collapsed));
		}
		parts.push(this.runDetails(current));
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
		// A random boundary would change the body on every render; one keyed by the publisher's secret is stable and unguessable.
		const nonce = createHmac("sha256", this.draft.secret)
			.update(`agent-prompt:${verdict.fingerprint()}`)
			.digest("hex")
			.slice(0, 24);
		const prompt = withPrompt ? verdict.agentPrompt(`#${pullRequest}`, nonce) : "";
		if (prompt !== "") parts.push(details("Prompt for agents", prompt));
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
							({ name, version, level, models, ran, lineage, budget, usage }) =>
								`- ${prose(name)}@${prose(version)}, ${prose(level)}; route ${models.map(prose).join(", ")}${ran === undefined ? "" : `; ran on ${prose(ran)}`}${lineage === undefined ? "" : `; ${prose(lineage)}`}; budgets ${prose(JSON.stringify(budget))}${usage === undefined ? "" : `; used ${usage.models.map(prose).join(", ")}, ${usage.tokens} tokens, $${usage.cost.toFixed(6)}`}`,
						),
					];
		return details("Run details", lines.join("\n\n"));
	}

	private history(round: LedgerRound | LedgerHistory, links: RepositoryLinks): string {
		if (!("verdict" in round))
			return details(
				`Earlier round ${round.round} at ${round.head.slice(0, 12)}`,
				`${round.base.slice(0, 12)}..${round.head.slice(0, 12)}; ${round.status}.`,
			);
		const verdict = Verdict.from(round.verdict);
		const prior = new Ledger({ ...this.draft, verdict, publication: { rounds: [round] } }, this.stamp);
		return details(
			`Earlier round ${round.round} at ${round.head.slice(0, 12)}`,
			prior.sections(links, false).join("\n\n"),
		);
	}
}
