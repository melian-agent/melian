// Known limits, accepted by the maintainer:
// - commits a force-push replaced appear only as the force-push row's tips;
// - a Timing: line sits at its comment's creation time, even if the comment was edited later;
// - a Timing: line counts whoever wrote the comment;
// - a Timing: line is self-reported, and only its minutes and cost fields are totalled; a cause or a note is commentary,
//   never read for numbers, so time or money written only there is not counted (the coordinator's answer, 2026-11-13);
// - two pull requests sharing a head SHA share its runs, since GitHub's run record no longer names the pull request once it merges.
//
// The coordinator answered on 2026-11-13, for issue #402, that a round's Spend line sits under the limit AGENTS.md states
// for a round comment: it counts what the comment says now, which a writer can edit, until issue #286 binds a round
// comment's body to its run.
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { toString as markdownText } from "mdast-util-to-string";
import { visibleText } from "../packages/core/src/render.ts";

export const HOUR = 3_600_000;

export const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number createdAt headRefName baseRefName body author { login }
      closingIssuesReferences(first: 10) {
        pageInfo { hasNextPage }
        nodes {
          number createdAt
          timelineItems(first: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ISSUE_COMMENT]) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on LabeledEvent { createdAt label { name } }
              ... on UnlabeledEvent { createdAt label { name } }
              ... on IssueComment { createdAt body author { login ... on User { databaseId } } }
            }
          }
        }
      }
      commits(first: 100) {
        pageInfo { hasNextPage }
        nodes { commit { oid committedDate parents { totalCount } } }
      }
      timelineItems(first: 100, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, READY_FOR_REVIEW_EVENT, ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, MERGED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on IssueComment { createdAt body author { login ... on User { databaseId } } }
          ... on PullRequestReview { submittedAt state body author { login } }
          ... on ReadyForReviewEvent { createdAt }
          ... on AddedToMergeQueueEvent { createdAt }
          ... on RemovedFromMergeQueueEvent { createdAt reason }
          ... on MergedEvent { createdAt commit { oid } }
          ... on HeadRefForcePushedEvent { createdAt beforeCommit { oid } afterCommit { oid } }
        }
      }
    }
  }
}`;

// The kinds a Timing item may name, in the order the summary totals them; AGENTS.md's Work from issues defines the grammar.
export const KINDS = [
	"gate",
	"round",
	"own-build round",
	"host round",
	"codex",
	"review of record",
	"mutants",
	"wait",
	"other",
];

// At most six whole digits and two decimals, read as whole hundredths, so every total is an exact integer sum.
const NUMBER = String.raw`\d{1,6}(?:\.\d{1,2})?`;
const hundredths = (text) => {
	const [whole, fraction = ""] = text.split(".");
	return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};
const ITEM = new RegExp(
	String.raw`^(?<kind>${KINDS.join("|")}) (?:(?<count>[1-9]\d{0,2}) × )?(?<minutes>${NUMBER}) min(?:, \$(?<cost>${NUMBER}))?(?: for (?<cause>[^()]+))?(?: \((?<note>[^()]+)\))?$`,
);
// Shapes older reports used, read as the kind they mean; any other free text stays unparsed rather than half-counted.
const LEGACY_WAIT = new RegExp(String.raw`^waited (?<minutes>${NUMBER}) min for (?<cause>.+)$`);
const LEGACY_KINDS = new Map([
	["gates", "gate"],
	["rounds", "round"],
	["Actions round", "round"],
	["Actions rounds", "round"],
	["Melian round", "round"],
	["Melian rounds", "round"],
	["own-build rounds", "own-build round"],
	["host rounds", "host round"],
	["Codex review", "codex"],
	["Codex reviews", "codex"],
	["reviews of record", "review of record"],
]);

function parseItem(text) {
	const legacyWait = LEGACY_WAIT.exec(text);
	if (legacyWait)
		return {
			kind: "wait",
			count: 1,
			minutes: hundredths(legacyWait.groups.minutes) / 100,
			cause: legacyWait.groups.cause,
		};
	let canonical = text;
	for (const [alias, kind] of LEGACY_KINDS)
		if (text.startsWith(`${alias} `)) {
			canonical = `${kind}${text.slice(alias.length)}`;
			break;
		}
	const match = ITEM.exec(canonical);
	if (!match) return {};
	const { kind, count, minutes, cost, cause, note } = match.groups;
	// Only a wait names its cause, and it must; an other must carry a note saying what it was.
	if ((kind === "wait") !== (cause !== undefined)) return {};
	if (kind === "other" && note === undefined) return {};
	if (cause?.trim() === "" || note?.trim() === "") return {};
	return {
		kind,
		count: Number(count ?? 1),
		minutes: (Number(count ?? 1) * hundredths(minutes)) / 100,
		...(cost === undefined ? {} : { cost: hundredths(cost) / 100 }),
		...(cause === undefined ? {} : { cause }),
		...(note === undefined ? {} : { note }),
	};
}

// What a comment says comes from its own top-level paragraphs, never from code, quotes or lists.
const paragraphLines = (body) =>
	fromMarkdown(body)
		.children.filter((node) => node.type === "paragraph")
		.map(markdownText)
		.flatMap((text) => text.split("\n"));

export function parseTiming(body) {
	const items = [];
	for (const line of paragraphLines(body)) {
		const match = /^Timing:(.*)$/s.exec(line);
		if (!match) continue;
		for (const raw of match[1].split(";")) {
			const text = raw.trim().replace(/\.$/, "");
			if (text === "") continue;
			items.push({ text, ...parseItem(text) });
		}
	}
	return items;
}

// A round's spend from the comment the melian round workflow posts as melian-status-bot: a line of the comment's first
// code fence, as round.mjs's spendLine writes it. Every line of that fence that holds a model's or a check's text starts
// with spaces, so only spendLine starts one with "Spend: ". Undefined for any other comment. A round comment with no
// such line, or one it cannot read whole, is still a round, with no spend, so the Rounds row counts it.
// AGENTS.md recognises the bot by login and account ID together, since a login can pass to another account.
export function parseRound(body, author) {
	if (author?.login !== "melian-status-bot" || author.databaseId !== 353727783) return undefined;
	if (!body.startsWith("<!-- melian-round run:")) return undefined;
	const fence = fromMarkdown(body).children.find((node) => node.type === "code");
	// A comment edited on GitHub's web page comes back with CRLF line endings, which the code block keeps.
	const line = fence?.value.split(/\r?\n/).find((each) => each.startsWith("Spend: "));
	if (line === undefined) return {};
	const spend = {};
	for (const part of line.slice("Spend: ".length).split(", ")) {
		const [, seconds, tokens, cost] = /^(?:(\d+) s|(\d+) tokens|\$(\d+\.\d{2}))$/.exec(part) ?? [];
		if (seconds !== undefined) spend.seconds = Number(seconds);
		else if (tokens !== undefined) spend.tokens = Number(tokens);
		else if (cost !== undefined) spend.cost = Number(cost);
		else return {};
	}
	return spend;
}

const roundDetail = ({ seconds, tokens, cost }) =>
	[
		...(seconds === undefined ? [] : [`${(seconds / 60).toFixed(1)} min`]),
		...(tokens === undefined ? [] : [`${tokens} tokens`]),
		...(cost === undefined ? [] : [`$${cost.toFixed(2)}`]),
	].join(", ") || "no spend";

const login = (node) => node.author?.login ?? "ghost";
// toMarkdown ends what it writes with a line ending, and without the table extension it leaves pipes alone.
const cell = (text) => visibleText(toMarkdown({ type: "text", value: text }).replace(/\n$/, "")).replaceAll("|", "\\|");
const row = (...cells) => `| ${cells.map(cell).join(" | ")} |`;
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export class Timeline {
	#events;
	#merged;

	constructor(events, merged) {
		this.#events = events;
		this.#merged = merged;
	}

	static fetch({ number, repo, gh, now = new Date().toISOString() }) {
		const [owner, name] = repo.split("/");
		const data = JSON.parse(
			gh([
				"api",
				"graphql",
				"-f",
				`query=${QUERY}`,
				"-F",
				`owner=${owner}`,
				"-F",
				`name=${name}`,
				"-F",
				`number=${number}`,
			]),
		);
		const pull = data.data.repository.pullRequest;
		const pages = [
			pull.closingIssuesReferences,
			pull.commits,
			pull.timelineItems,
			...pull.closingIssuesReferences.nodes.map((issue) => issue.timelineItems),
		];
		if (pages.some((page) => page.pageInfo.hasNextPage))
			throw new Error(
				`pull request #${number} has more items than one page holds; the timeline would be incomplete`,
			);
		const runs = (args) => {
			const pages = JSON.parse(
				gh(["api", "--paginate", "--slurp", "-X", "GET", `repos/${repo}/actions/runs`, ...args]),
			);
			const found = pages.flatMap((page) => page.workflow_runs);
			// GitHub stops a filtered run search at 1,000 results and says so only in total_count.
			if (pages[0].total_count > found.length)
				throw new Error(
					`GitHub found ${pages[0].total_count} workflow runs and returned ${found.length}; the timeline would be incomplete`,
				);
			return found;
		};
		const merge = pull.timelineItems.nodes.find((node) => node.__typename === "MergedEvent");
		// A branch run belongs to this pull request by commit, never by branch name or time, so ask GitHub per SHA.
		const tips = [
			...new Set([
				...pull.commits.nodes.map(({ commit }) => commit.oid),
				...pull.timelineItems.nodes
					.filter((node) => node.__typename === "HeadRefForcePushedEvent")
					.flatMap((node) => [node.beforeCommit, node.afterCommit])
					.filter((tip) => tip !== null)
					.map((tip) => tip.oid),
			]),
		];
		const branch = tips.flatMap((sha) => runs(["-f", `head_sha=${sha}`, "-f", "per_page=100"]));
		const group = runs([
			"-f",
			"event=merge_group",
			"-f",
			`created=${pull.createdAt}..${merge?.createdAt ?? now}`,
			"-f",
			"per_page=100",
		]);
		const base = pull.baseRefName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		const queue = new RegExp(`^gh-readonly-queue/${base}/pr-${number}-[0-9a-f]{40}$`);
		return Timeline.from({ pull, runs: [...branch, ...group.filter((run) => queue.test(run.head_branch))] });
	}

	static from({ pull, runs }) {
		const events = [];
		const add = (at, event, detail, end) =>
			events.push({ at: Date.parse(at), end: end && Date.parse(end), event, detail });
		const timing = (at, body) => {
			for (const item of parseTiming(body))
				events.push({ at: Date.parse(at), event: "Timing", item, detail: item.text });
		};
		let merged;
		for (const issue of pull.closingIssuesReferences.nodes) {
			add(issue.createdAt, "issue opened", `#${issue.number}`);
			for (const node of issue.timelineItems.nodes) {
				if (node.__typename === "IssueComment") {
					const opening = paragraphLines(node.body)[0] ?? "";
					for (const marker of ["Claim:", "Fix pass"])
						if (opening.startsWith(marker))
							add(node.createdAt, marker.replace(":", ""), `#${issue.number} by ${login(node)}`);
					timing(node.createdAt, node.body);
				} else if (node.label.name.startsWith("status:")) {
					add(
						node.createdAt,
						node.__typename === "LabeledEvent" ? "labelled" : "unlabelled",
						`#${issue.number} ${node.label.name}`,
					);
				}
			}
		}
		add(pull.createdAt, "pull request opened", `#${pull.number} by ${login(pull)}`);
		for (const { commit } of pull.commits.nodes) {
			add(commit.committedDate, commit.parents.totalCount > 1 ? "merge commit" : "commit", commit.oid.slice(0, 8));
		}
		for (const node of pull.timelineItems.nodes) {
			switch (node.__typename) {
				case "IssueComment": {
					add(node.createdAt, "comment", `by ${login(node)}`);
					timing(node.createdAt, node.body);
					const round = parseRound(node.body, node.author);
					if (round !== undefined)
						events.push({ at: Date.parse(node.createdAt), event: "round", round, detail: roundDetail(round) });
					break;
				}
				case "PullRequestReview":
					add(node.submittedAt, "review", `${node.state.toLowerCase()} by ${login(node)}`);
					break;
				case "ReadyForReviewEvent":
					add(node.createdAt, "ready for review", "");
					break;
				case "AddedToMergeQueueEvent":
					add(node.createdAt, "queued", "");
					break;
				case "RemovedFromMergeQueueEvent":
					add(node.createdAt, "left the queue", (node.reason ?? "").toLowerCase());
					break;
				case "HeadRefForcePushedEvent": {
					const short = (commit) => commit?.oid.slice(0, 8) ?? "unknown";
					add(node.createdAt, "force-pushed", `${short(node.beforeCommit)} to ${short(node.afterCommit)}`);
					break;
				}
				case "MergedEvent":
					add(node.createdAt, "merged", node.commit.oid.slice(0, 8));
					merged = Date.parse(node.createdAt);
					break;
			}
		}
		for (const run of runs) {
			// A queued run has not started, so GitHub gives it no run_started_at.
			const started = run.run_started_at ?? run.created_at;
			const minutes = (Date.parse(run.updated_at) - Date.parse(started)) / 60_000;
			const where = run.event === "merge_group" ? "merge group" : run.head_sha.slice(0, 8);
			const attempt = run.run_attempt > 1 ? `, attempt ${run.run_attempt}` : "";
			add(
				started,
				`CI ${run.name}`,
				`${where}, ${run.conclusion ?? run.status}, ${minutes.toFixed(1)} min${attempt}`,
				run.updated_at,
			);
		}
		events.sort((a, b) => a.at - b.at);
		return new Timeline(events, merged);
	}

	render() {
		const first = this.#events[0].at;
		const lines = ["| Time (UTC) | Hours | Event | Detail |", "| --- | --- | --- | --- |"];
		let latest = first;
		for (const event of this.#events) {
			// A Timing item sits at its own comment's time, so it can never end a gap the comment did not.
			if (event.at - latest > HOUR) lines.push(row("", "", "gap", `${((event.at - latest) / HOUR).toFixed(1)} h`));
			latest = Math.max(latest, event.end ?? event.at);
			lines.push(row(stamp(event.at), ((event.at - first) / HOUR).toFixed(2), event.event, event.detail));
		}
		const timed = this.#events.filter((event) => event.event === "Timing");
		// An item's minutes and cost are whole hundredths over 100, so times 100 recovers the integer, and every sum is exact.
		const whole = (value) => Math.round(value * 100);
		const kinds = KINDS.flatMap((kind) => {
			const items = timed.filter((event) => event.item.kind === kind);
			if (items.length === 0) return [];
			const minutes = items.reduce((sum, event) => sum + whole(event.item.minutes), 0);
			const cost = items.reduce((sum, event) => sum + whole(event.item.cost ?? 0), 0);
			return [{ kind, minutes, cost }];
		});
		const minutes = kinds.reduce((sum, kind) => sum + kind.minutes, 0);
		const cost = kinds.reduce((sum, kind) => sum + kind.cost, 0);
		const spend = (minutes, cost) => `${minutes / 100} min${cost === 0 ? "" : `, $${(cost / 100).toFixed(2)}`}`;
		lines.push("", "| Summary | Value |", "| --- | --- |");
		lines.push(row("Timing reported", kinds.length === 0 ? "none" : spend(minutes, cost)));
		for (const kind of kinds) lines.push(row(`Timing: ${kind.kind}`, spend(kind.minutes, kind.cost)));
		const rounds = this.#events.filter((event) => event.round !== undefined);
		if (rounds.length > 0) {
			// A sum over fewer rounds than were counted says how many it covers, so it never reads as the whole.
			const sumOf = (key, format) => {
				const known = rounds.filter((event) => event.round[key] !== undefined);
				if (known.length === 0) return [];
				const total = format(known.reduce((sum, event) => sum + event.round[key], 0));
				return [known.length === rounds.length ? total : `${total} over ${known.length}`];
			};
			const parts = [
				`${rounds.length} round${rounds.length === 1 ? "" : "s"}`,
				...sumOf("seconds", (seconds) => `${Number((seconds / 60).toFixed(1))} min`),
				...sumOf("cost", (cost) => `$${cost.toFixed(2)}`),
			];
			lines.push(row("Rounds", parts.join(", ")));
		}
		const ci = this.#events.filter((event) => event.end !== undefined);
		const ciMinutes = ci.reduce((sum, event) => sum + (event.end - event.at) / 60_000, 0);
		const last = this.#merged ?? Math.max(...this.#events.map((event) => event.end ?? event.at));
		lines.push(row("CI", `${ciMinutes.toFixed(1)} min over ${ci.length} runs`));
		lines.push(row("total", `${((last - first) / HOUR).toFixed(2)} h`));
		const unparsed = timed.filter((event) => event.item.kind === undefined);
		if (unparsed.length > 0) {
			lines.push("", "| Timing not parsed | Comment time (UTC) |", "| --- | --- |");
			for (const event of unparsed) lines.push(row(event.item.text, stamp(event.at)));
		}
		return lines.join("\n");
	}
}
