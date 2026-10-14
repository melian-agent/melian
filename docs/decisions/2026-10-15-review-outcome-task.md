# The review outcome task learns from a merged pull request's review history

Problem: the lessons of a review loop are found by a person reading many rounds side by side, and then only sometimes. Nothing in Melian reads its own history. The patterns that cost the most rounds were each seen late, by hand.

Example: on [pull request #117](https://github.com/melian-agent/melian/pull/117), rounds one, two and four each found one more input missing from the adjudication task's attachment key. On [pull request #114](https://github.com/melian-agent/melian/pull/114), every finding above advisory after round two sat on runner code the previous fix pass had just added. A decision that supersedes another and drops clauses recurred on [#111](https://github.com/melian-agent/melian/pull/111), [#116](https://github.com/melian-agent/melian/pull/116) and [#117](https://github.com/melian-agent/melian/pull/117). The class of [#116](https://github.com/melian-agent/melian/pull/116)'s finding C1, an instruction that names an input the request never supplies, has no lens. A record author found each of these by reading saved round files, and each became guidance only because someone wrote it down.

Choice: a review outcome task. The maintainer named it the review outcome lens, for learning from the review pass; it is not a diff lens, because its input is a review history, not a change. For now it serves Melian's own repository. Later it feeds milestone 4's learning loop for customer repositories.

`melian learn "#N"` runs it on a merged pull request. Its inputs, all read from the clone and GitHub, none from a model:

- Every stored Melian round of the pull request, addressed by head commit as [the compare decision](2026-10-15-compare-addresses-revisions-by-head.md) sets out. From each: the verdict and status, the start and finish times, each check record with its outcome and the reason a check ended, failed or skipped, and each finding sighting with its ID, rule, lens, severity, cause, file, lines and title.
- The pull request's comparison: each external finding with its reviewer and the round head it was imported at, the matches, and each adjudication with its verdict, severity, miss reason, owed golden and lens, and rule tag.
- Dismissals and their reasons.
- The fix commits: the commits between consecutive round heads, with the files and line ranges each changed, from git.
- For recurrence only, every other comparison in the clone, as `melian compare stats` reads them.

It computes four kinds of signal, deterministically:

- Repeated classes. A rule ID or adjudication tag that draws a new finding ID in two consecutive rounds. This is the shape `AGENTS.md` tells the coordinator to escalate as a class.
- Recurring findings. A rule tag or normalised title cluster valid on two or more merged pull requests. Each is a candidate check, as `AGENTS.md` asks of a repeated finding.
- Lens gaps. Valid findings adjudicated `no-owner`, grouped by tag, with the nearest lens named where an adjudication named one.
- Process signals. Findings whose cause lines a fix commit added since the previous round. The round count and each round's duration. Rounds that read `not reviewed`, and why. Findings that resolved and came back.

Its output is a draft guidance change for a maintainer, never applied. Markdown by default, with a section per kind of signal, each signal citing its finding IDs, rounds and commits. A last section proposes entries for `AGENTS.md`'s Learnings in its form, symptom then cause then what to do, and candidate checks or lens rules. A model on the light tier drafts that prose from the computed signals, quoted as data, and a proposal that cites no signal is dropped. `--json` prints the signals alone and calls no model. `--out <path>` is its only file write, as for `melian compare export`. It never edits `AGENTS.md`, a lens, or a decision; [writing back](../design.md#writing-back) is a proposal by pull request, as for any knowledge.

Goldens live under `packages/evals/learn/`. Each is a pull request history written by Melian's own scripted rounds on the fake model, never by hand, with the lesson it must yield:

- a class that draws a new instance in two consecutive rounds, which must yield a repeated class;
- fix passes whose own lines draw the next round's findings, which must yield the process signal;
- one finding shape adjudicated valid on two pull requests, which must yield a candidate check;
- a `no-owner` finding, which must yield a lens gap;
- a clean history of one round with no findings, which must yield no proposal.

What this gives up: the task sees only what the store holds, so a loop run partly outside Melian, such as a review of record that left only a markdown file, reaches it only through an import. It reads history after the merge, not during the loop, so it does not stop the next wasted round of the pull request it reads. The coordinator's rule to escalate a class after two rounds covers that meanwhile.

It needs [`melian compare` to address a merged pull request's rounds](2026-10-15-compare-addresses-revisions-by-head.md) first.
