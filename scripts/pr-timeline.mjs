import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HOUR = 3_600_000;

export const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number createdAt headRefName body author { login }
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
      timelineItems(first: 100, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, READY_FOR_REVIEW_EVENT, ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, MERGED_EVENT]) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on IssueComment { createdAt body author { login } }
          ... on PullRequestReview { submittedAt state body author { login } }
          ... on ReadyForReviewEvent { createdAt }
          ... on AddedToMergeQueueEvent { createdAt }
          ... on RemovedFromMergeQueueEvent { createdAt reason }
          ... on MergedEvent { createdAt commit { oid } }
        }
      }
    }
  }
}`;

const WAIT = /^waited (\d+(?:\.\d+)?) min for (.+)$/;
const WORK = /^(.+?) (?:(\d+) × )?(\d+(?:\.\d+)?) min(?:, \$(\d+(?:\.\d+)?))?$/;

export function parseTiming(body) {
	const items = [];
	for (const line of body.split("\n")) {
		const match = /^Timing:(.*)$/.exec(line.trim());
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
const cell = (text) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export class Timeline {
	#events;
	#stages;

	constructor(events, stages) {
		this.#events = events;
		this.#stages = stages;
	}

	static fetch({ number, repo, gh }) {
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
		const runs = (args) =>
			JSON.parse(gh(["api", "--paginate", "--slurp", "-X", "GET", `repos/${repo}/actions/runs`, ...args]));
		const branch = runs(["-f", `branch=${pull.headRefName}`, "-f", "per_page=100"]);
		const group = runs([
			"-f",
			"event=merge_group",
			"-f",
			`created=>=${pull.createdAt.slice(0, 10)}`,
			"-f",
			"per_page=100",
		]);
		const queued = group
			.flatMap((page) => page.workflow_runs)
			.filter((run) => run.head_branch.includes(`/pr-${number}-`));
		return Timeline.from({ pull, runs: [...branch.flatMap((page) => page.workflow_runs), ...queued] });
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
			for (const node of issue.timelineItems.nodes) {
				if (node.__typename === "IssueComment") {
					for (const marker of ["Claim:", "Fix pass"])
						if (node.body.trimStart().startsWith(marker))
							add(node.createdAt, marker.replace(":", ""), `#${issue.number} by ${login(node)}`);
					if (node.body.trimStart().startsWith("Claim:")) stages.claim ??= Date.parse(node.createdAt);
					timing(node.createdAt, node.body);
				} else if (node.label.name.startsWith("status:")) {
					add(
						node.createdAt,
						node.__typename === "LabeledEvent" ? "labelled" : "unlabelled",
						`#${issue.number} ${node.label.name}`,
					);
					if (node.__typename === "LabeledEvent" && node.label.name === "status: ready")
						stages.ready ??= Date.parse(node.createdAt);
				}
			}
			stages.ready ??= Date.parse(issue.createdAt);
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
				case "MergedEvent":
					add(node.createdAt, "merged", node.commit.oid.slice(0, 8));
					stages.merged = Date.parse(node.createdAt);
					break;
			}
		}
		for (const run of runs) {
			const minutes = (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 60_000;
			const where = run.event === "merge_group" ? "merge group" : run.head_sha.slice(0, 8);
			add(
				run.run_started_at,
				`CI ${run.name}`,
				`${where}, ${run.conclusion ?? run.status}, ${minutes.toFixed(1)} min`,
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
			if (event.at - latest > HOUR) lines.push(`|  |  | gap | ${((event.at - latest) / HOUR).toFixed(1)} h |`);
			latest = Math.max(latest, event.end ?? event.at);
			lines.push(
				`| ${stamp(event.at)} | ${((event.at - first) / HOUR).toFixed(2)} | ${event.event} | ${cell(event.detail)} |`,
			);
		}
		const { ready, claim, built, reviewed, queued, merged } = this.#stages;
		const stages = [
			["ready-wait", ready, claim],
			["build", claim, built],
			["review", built, reviewed],
			["queue", queued, merged],
		];
		lines.push("", "| Stage | Hours | Timing reported |", "| --- | --- | --- |");
		for (const [name, start, end] of stages) {
			const known = start !== undefined && end !== undefined;
			const items = known ? this.#events.filter((event) => event.item && event.at >= start && event.at < end) : [];
			const minutes = items.reduce((sum, event) => sum + (event.item.minutes ?? 0), 0);
			const cost = items.reduce((sum, event) => sum + (event.item.cost ?? 0), 0);
			const reported = minutes === 0 ? "" : `${minutes} min${cost === 0 ? "" : `, $${cost.toFixed(2)}`}`;
			lines.push(`| ${name} | ${known ? ((end - start) / HOUR).toFixed(2) : "—"} | ${reported} |`);
		}
		const ci = this.#events.filter((event) => event.end !== undefined);
		const ciMinutes = ci.reduce((sum, event) => sum + (event.end - event.at) / 60_000, 0);
		const last = Math.max(...this.#events.map((event) => event.end ?? event.at));
		lines.push(`| CI | ${ciMinutes.toFixed(1)} min over ${ci.length} runs |  |`);
		lines.push(`| total | ${((last - first) / HOUR).toFixed(2)} |  |`);
		return lines.join("\n");
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [number, ...flags] = process.argv.slice(2);
	const option = (name) => {
		const at = flags.indexOf(name);
		return at === -1 ? undefined : flags[at + 1];
	};
	if (!/^\d+$/.test(number ?? "")) {
		console.error("usage: node scripts/pr-timeline.mjs <number> [--repo owner/name] [--record file.json]");
		process.exit(2);
	}
	const record = option("--record");
	const requests = [];
	const gh = (args) => {
		const stdout = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
		requests.push({ args, stdout });
		return stdout;
	};
	const timeline = Timeline.fetch({ number: Number(number), repo: option("--repo") ?? "melian-agent/melian", gh });
	if (record) writeFileSync(record, `${JSON.stringify(requests, null, "\t")}\n`);
	console.log(timeline.render());
}
