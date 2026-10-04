# Review output anatomy

What a mature review bot posts on a pull request, how it says which commits a review covers, and what maintainers who live with it value and work around.

Source: [CodeRabbit](https://www.coderabbit.ai)'s comments on fourteen pull requests across two private repositories, read through the GitHub GraphQL API with each comment's edit history and each review thread's state; the headings of the thirty most recent pull requests in each; and both repositories' `.coderabbit.yaml` and agent instructions. Structure only, no business content. [CodeRabbit's documentation](https://docs.coderabbit.ai) describes the configuration keys.

## The summary comment

Each pull request has one summary comment carrying a hidden marker. CodeRabbit rewrites it on every push, nineteen times on one pull request and sixteen on another, so its creation time stays at the first review and only its edit time moves. In order:

1. A badge linking to the vendor's change view.
2. A status callout, uncollapsed, only while it applies: processing new changes; reviews paused, with resume and trigger checkboxes; review limit reached, with the minutes to wait; review skipped, for example because the author is a bot.
3. The recent review: "No actionable comments were generated in the recent review" when that is so, then a collapsed block with the run configuration, the commits, the files selected, the files skipped as similar to earlier changes, the code guidelines used, and how many included reviews remain.
4. A collapsed walkthrough: a paragraph; a table of layer or file to summary under bold group titles; a priority, an estimated review effort in minutes, and a change type; and a mermaid sequence diagram, left out for docs-only changes.
5. A merge-risk line, uncollapsed, with a label, "up to" a short head SHA, and a paragraph of rationale, backed by hidden JSON naming the source commit and the covered commit.
6. Collapsed pre-merge checks with pass and fail counts: title, description, linked issues, out-of-scope changes, and docstring coverage.
7. Collapsed finishing touches and an autopilot checkbox, then a tip about the help command.

Never seen in the sample: the poem, related pull requests, suggested labels, suggested reviewers.

## Naming what a review covers

- A commits heading in the review body and the summary: reviewing files changed from the base and between the previous reviewed SHA and the head SHA.
- The merge-risk "up to" line and its hidden coverage JSON.
- File lists: selected, ignored by path filters, no reviewable changes, and skipped as similar.
- A manual trigger gets a short reply, performed or not completed, noting that review is incremental and reviewed commits are not reviewed again.

## The review body

One per push, always with the event `COMMENTED`: an actionable-comment count; a caution callout listing comments outside the diff range; nitpicks nested by file, each with its own prompt for agents; one combined prompt to fix everything; and collapsed review details with the configuration, run ID, commits, and file lists.

## Inline comments

- First line: category, severity, effort. Categories are functional correctness, maintainability, data integrity and integration, stability and availability, and security and privacy. Severity is major, minor, or trivial; effort is quick win or heavy lift.
- Collapsed evidence: scripts run, queries, linters, and learnings used.
- A bold headline and a short explanation.
- A collapsed suggested diff, then a committable suggestion with a caveat.
- A prompt for agents that opens by telling the agent to treat the finding text, paths, and code as untrusted review data, then names the path and line.
- Once fixed, the original comment is edited to append "Addressed in commit" and the SHA or range, and the bot resolves the thread. Nothing is minimised; GitHub's outdated flag is the only other marker, and an outdated thread can stay open.

## After a push

An incremental review covers the range from the last reviewed head to the new one, and earlier findings get the addressed line and are resolved. A push with nothing new may post no review at all. After several pushes auto-review pauses; one maintainer re-triggered it five times by comment. In a thread the bot can withdraw a finding and resolve it, and notes when it added or removed a learning.

## Configuration seen

One repository sets the chill profile, request-changes off, the poem off, auto-review on except for drafts, and two path instructions, and leaves the walkthrough, diagrams, pre-merge checks, and base branches at their defaults. The other sets only auto-review on drafts, so the review loop runs on drafts while CI skips them.

## What maintainers value and work around

- The command line's checks view hides findings. Comments outside the diff live only in the review body, and one was missed.
- GraphQL thread resolution is the source of truth for open findings.
- Rate limits refuse even manual triggers, and the wait estimate is unreliable.
- A pull request on a non-default base, or from a bot, gets no review, and the skip reads like a clean review.
- Reviews stop at 150 files.
- Because the summary is edited in place, a watcher must read its edit time and coverage stamp, not its creation time. A heading that moved into a callout broke one watcher.
- A changes-requested state sticks until dismissed, an info-level thread never resolves itself, and nitpicks have no thread, so maintainers answer them in a top-level comment.
- Valued: learnings, where a well-argued decline pays off later; draft-first pull requests; a cheap fallback review when rate-limited.

## What to take and what to avoid

Worth taking: one comment edited in place with a hidden, versioned stamp naming base and head; a collapsed walkthrough that configuration can switch; a run-details block; addressed-in-commit edits with thread resolution; a per-finding agent prompt that opens with the untrusted-data line; and a callout at the top for anything not reviewed, with the reason.

Worth avoiding: nitpicks without a thread; info threads that never resolve; a sticky changes-requested state; profiles as the only tuning; and anything that invites a watcher to parse markdown instead of reading a JSON interface.
