# Review output anatomy

What a mature review bot posts on a pull request, how it says which commits a review covers, and what maintainers who live with it value and work around.

Source: [CodeRabbit](https://www.coderabbit.ai)'s comments on fourteen pull requests across two private repositories, read through the GitHub GraphQL API with each comment's edit history and each review thread's state; the headings of the thirty most recent pull requests in each; and both repositories' `.coderabbit.yaml` and agent instructions. Structure only, no business content. [CodeRabbit's documentation](https://docs.coderabbit.ai) describes the configuration keys.

## The summary comment

Each pull request has one summary comment with a hidden marker. CodeRabbit rewrites it on every push, nineteen times on one pull request, so only its edit time moves. In order:

1. A badge linking to the vendor's change view.
2. A status callout, uncollapsed, only while it applies: processing; reviews paused, with resume checkboxes; review limit reached, with the wait; review skipped, say for a bot author.
3. The recent review: a line saying nothing actionable was found, when so, then a collapsed block with the run configuration, the commits, the files selected and skipped, the code guidelines used, and the reviews remaining.
4. A collapsed walkthrough: a paragraph; a table of layer or file to summary; a priority, an estimated review effort, and a change type; and a mermaid sequence diagram, left out for docs-only changes.
5. A merge-risk line, uncollapsed, with a label, "up to" a short head SHA, and a paragraph of rationale, backed by hidden JSON naming the source commit and the covered commit.
6. Collapsed pre-merge checks with pass and fail counts: title, description, linked issues, out-of-scope changes, and docstring coverage.
7. Collapsed finishing touches and an autopilot checkbox, then a tip about the help command.

Never seen in the sample: the poem, related pull requests, suggested labels, suggested reviewers.

## Naming what a review covers

- A commits heading in the review body and the summary, naming the previous reviewed SHA and the head SHA.
- The merge-risk "up to" line and its hidden coverage JSON.
- File lists: selected, ignored by path filters, no reviewable changes, and skipped as similar.
- A manual trigger gets a short reply noting that review is incremental.

## The review body

One per push, always with the event `COMMENTED`: an actionable-comment count; a callout listing comments outside the diff; nitpicks by file, each with a prompt for agents; one combined prompt to fix everything; and collapsed details with the configuration, run ID, commits, and files.

## Inline comments

- First line: category, severity, effort. Categories are functional correctness, maintainability, data integrity and integration, stability and availability, and security and privacy. Severity is major, minor, or trivial; effort is quick win or heavy lift.
- Collapsed evidence: scripts run, queries, linters, and learnings used.
- A bold headline and a short explanation.
- A collapsed suggested diff, then a committable suggestion with a caveat.
- A prompt for agents that opens by telling the agent to treat the finding text, paths, and code as untrusted review data, then names the path and line.
- Once fixed, the original comment is edited to append "Addressed in commit" and the SHA or range, and the bot resolves the thread. Nothing is minimised; GitHub's outdated flag is the only other marker, and an outdated thread can stay open.

## After a push

An incremental review covers the range from the last reviewed head to the new one, and fixed findings get the addressed line and are resolved. A push with nothing new may post no review. After several pushes auto-review pauses; one maintainer re-triggered it five times. In a thread the bot can withdraw a finding, and notes when it changes a learning.

## Configuration seen

One repository sets the chill profile, request-changes off, auto-review except on drafts, and two path instructions, and leaves the walkthrough and pre-merge checks at their defaults. The other only turns auto-review on for drafts, which CI skips.

## What maintainers value and work around

- The command line's checks view hides findings. Comments outside the diff live only in the review body, and one was missed.
- GraphQL thread resolution is the source of truth for open findings.
- Rate limits refuse even manual triggers, and the wait estimate is unreliable.
- A pull request on a non-default base, or from a bot, gets no review, and the skip reads like a clean review.
- Reviews stop at 150 files.
- Because the summary is edited in place, a watcher must read its edit time and coverage stamp, not its creation time. A heading that moved into a callout broke one watcher.
- A changes-requested state sticks until dismissed, an info thread never resolves itself, and nitpicks have no thread.
- Valued: learnings, where a well-argued decline pays off later; draft-first pull requests; a cheap fallback review when rate-limited.

## What to take and what to avoid

Worth taking: one comment edited in place with a hidden, versioned stamp naming base and head; a collapsed walkthrough that configuration can switch; a run-details block; addressed-in-commit edits with thread resolution; a per-finding agent prompt that opens with the untrusted-data line; and a callout at the top for anything not reviewed, with the reason.

Worth avoiding: nitpicks without a thread; info threads that never resolve; a sticky changes-requested state; profiles as the only tuning; and anything that invites a watcher to parse markdown instead of reading a JSON interface.
