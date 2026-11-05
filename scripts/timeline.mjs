// Known limits, accepted by the maintainer:
// - commits a force-push replaced appear only as the force-push row's tips;
// - a Timing: line sits at its comment's creation time, even if the comment was edited later;
// - a pull request closing several issues reads the first issue's ready and claim;
// - two pull requests sharing a head SHA share its runs, since GitHub's run record no longer names the pull request once it merges.
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
              ... on IssueComment { createdAt body author { login } }
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
          ... on IssueComment { createdAt body author { login } }
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

const WAIT = /^waited (\d+(?:\.\d+)?) min for (.+)$/;
const WORK = /^(.+?) (?:(\d+) × )?(\d+(?:\.\d+)?) min(?:, \$(\d+(?:\.\d+)?))?$/;

export function parseTiming(body) {
	const items = [];
	for (const line of fromMarkdown(body)
		.children.filter((node) => node.type === "paragraph")
		.map(markdownText)
		.flatMap((text) => text.split("\n"))) {
		const match = /^Timing:(.*)$/s.exec(line);
		if (!match) continue;
		for (const raw of match[1].split(";")) {
			const text = raw.trim().replace(/\.$/, "");
			if (text === "") continue;
			const wait = WAIT.exec(text);
			if (wait) {
				items.push({ text, minutes: Number(wait[1]) });
				continue;
			}
			const work = WORK.exec(text);
			if (work) {
				const minutes = Number(work[2] ?? 1) * Number(work[3]);
				items.push({ text, minutes, ...(work[4] === undefined ? {} : { cost: Number(work[4]) }) });
			} else items.push({ text });
		}
	}
	return items;
}

const login = (node) => node.author?.login ?? "ghost";
// toMarkdown ends what it writes with a line ending, and without the table extension it leaves pipes alone.
const cell = (text) => visibleText(toMarkdown({ type: "text", value: text }).replace(/\n$/, "")).replaceAll("|", "\\|");
const row = (...cells) => `| ${cells.map(cell).join(" | ")} |`;
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export class Timeline {
	#events;
	#stages;

	constructor(events, stages) {
		this.#events = events;
		this.#stages = stages;
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
			for (const item of parseTiming(body ?? ""))
				events.push({ at: Date.parse(at), event: "Timing", item, detail: item.text });
		};
		const stages = {};
		for (const issue of pull.closingIssuesReferences.nodes) {
			add(issue.createdAt, "issue opened", `#${issue.number}`);
			const readied = [Date.parse(issue.createdAt)];
			const claims = [];
			for (const node of issue.timelineItems.nodes) {
				if (node.__typename === "IssueComment") {
					for (const marker of ["Claim:", "Fix pass"])
						if (node.body.trimStart().startsWith(marker))
							add(node.createdAt, marker.replace(":", ""), `#${issue.number} by ${login(node)}`);
					if (node.body.trimStart().startsWith("Claim:")) claims.push(Date.parse(node.createdAt));
					timing(node.createdAt, node.body);
				} else if (node.label.name.startsWith("status:")) {
					add(
						node.createdAt,
						node.__typename === "LabeledEvent" ? "labelled" : "unlabelled",
						`#${issue.number} ${node.label.name}`,
					);
					if (node.__typename === "LabeledEvent" && node.label.name === "status: ready")
						readied.push(Date.parse(node.createdAt));
				}
			}
			// The earliest claim since the issue was last marked ready wins, as AGENTS.md's Work from issues says.
			if (issue === pull.closingIssuesReferences.nodes[0]) {
				stages.ready = readied.at(-1);
				stages.claim = claims.find((claim) => claim >= stages.ready);
			}
		}
		add(pull.createdAt, "pull request opened", `#${pull.number} by ${login(pull)}`);
		timing(pull.createdAt, pull.body);
		for (const { commit } of pull.commits.nodes) {
			add(commit.committedDate, commit.parents.totalCount > 1 ? "merge commit" : "commit", commit.oid.slice(0, 8));
			stages.built = Math.max(stages.built ?? 0, Date.parse(commit.committedDate));
		}
		for (const node of pull.timelineItems.nodes) {
			switch (node.__typename) {
				case "IssueComment":
					add(node.createdAt, "comment", `by ${login(node)}`);
					timing(node.createdAt, node.body);
					break;
				case "PullRequestReview":
					add(node.submittedAt, "review", `${node.state.toLowerCase()} by ${login(node)}`);
					timing(node.submittedAt, node.body);
					break;
				case "ReadyForReviewEvent":
					add(node.createdAt, "ready for review", "");
					stages.reviewed = Date.parse(node.createdAt);
					break;
				case "AddedToMergeQueueEvent":
					add(node.createdAt, "queued", "");
					stages.queued = Date.parse(node.createdAt);
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
					stages.merged = Date.parse(node.createdAt);
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
		return new Timeline(events, stages);
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
		const { ready, claim, built, reviewed, queued, merged } = this.#stages;
		const stages = [
			["ready to claim", ready, claim],
			["claim to last commit", claim, built],
			["last commit to ready", built, reviewed],
			["queued to merged", queued, merged],
		];
		lines.push("", "| Stage | Hours | Timing reported |", "| --- | --- | --- |");
		for (const [name, start, end] of stages) {
			const known = start !== undefined && end !== undefined;
			const items = known ? this.#events.filter((event) => event.item && event.at >= start && event.at < end) : [];
			const minutes = items.reduce((sum, event) => sum + (event.item.minutes ?? 0), 0);
			const cost = items.reduce((sum, event) => sum + (event.item.cost ?? 0), 0);
			const reported = minutes === 0 ? "" : `${minutes} min${cost === 0 ? "" : `, $${cost.toFixed(2)}`}`;
			lines.push(row(name, known ? ((end - start) / HOUR).toFixed(2) : "—", reported));
		}
		const ci = this.#events.filter((event) => event.end !== undefined);
		const ciMinutes = ci.reduce((sum, event) => sum + (event.end - event.at) / 60_000, 0);
		const last = merged ?? Math.max(...this.#events.map((event) => event.end ?? event.at));
		lines.push(row("CI", `${ciMinutes.toFixed(1)} min over ${ci.length} runs`, ""));
		lines.push(row("total", ((last - first) / HOUR).toFixed(2), ""));
		return lines.join("\n");
	}
}
