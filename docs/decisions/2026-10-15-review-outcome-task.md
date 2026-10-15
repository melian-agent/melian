# The review outcome task learns from a merged pull request's review history

Problem: the lessons of a review loop are found by a person reading many rounds side by side, and then only sometimes. Nothing in Melian reads its own history. The patterns that cost the most rounds were each seen late, by hand.

Example: on [pull request #117](https://github.com/melian-agent/melian/pull/117), rounds one, two and four each found one more input missing from the adjudication task's attachment key. On [pull request #114](https://github.com/melian-agent/melian/pull/114), every finding above advisory after round two sat on runner code the previous fix pass had just added. A decision that supersedes another and drops clauses recurred on [#116](https://github.com/melian-agent/melian/pull/116) and [#117](https://github.com/melian-agent/melian/pull/117). The class of [#116](https://github.com/melian-agent/melian/pull/116)'s finding C1, an instruction that names an input the request never supplies, has no lens. A record author found each of these by reading saved round files, and each became guidance only because someone wrote it down.

Choice: the maintainer's words, a "review outcome lens, for meta learning from the review pass", which "will later feed Melian learns milestone for customer repos, but for now should be used for us to improve Melian itself". It is a task, not a diff lens, because its input is a review history, not a change. `melian learn "#N"` runs it on a merged pull request.

In outline:

- Inputs: the pull request's stored Melian rounds, its comparison with external findings and adjudications, its dismissals, and the fix commits between rounds.
- Signals, computed without a model: classes repeated across consecutive rounds, findings that recur across pull requests, lens gaps from `no-owner` adjudications, and process signals such as findings in code a fix pass just added.
- Output: a draft guidance change for a maintainer, with every proposal citing its signals, never applied. [Writing back](../design.md#writing-back) is a proposal by pull request, as for any knowledge.
- Goldens: pull request histories written by Melian's own scripted rounds on the fake model, each with the lesson it must yield, and a clean history that must yield none.

This decision records the problem and the direction only. The step that builds it, plan step 25, writes the full decision against the code first and has it attacked before any code. It stands on [the compare decision](2026-10-15-compare-addresses-revisions-by-head.md), which is held the same way, so it would inherit that design's open holes.

Open questions for the step:

- Which rounds are the pull request's. The task reads what `compare "#N"` gathers, so the compare step's answer on foreign rounds decides what this task counts. From Melian's fifth round on [pull request #122](https://github.com/melian-agent/melian/pull/122).
- Round times. The store holds no start or finish time for a round today, so durations need the round record the compare step adds, and older rounds read as unknown. Found by Codex's adversarial review of [pull request #122](https://github.com/melian-agent/melian/pull/122).
- Fix commits across rewritten history. Between two rounds whose heads diverge after a force-push, "the commits between them" is undefined, and attributing a finding to a fix pass there is a guess. From the same review.
- Who drafts the prose. A model on the light tier drafting from the computed signals, quoted as data, is the first idea. Whether a proposal that cites no signal is dropped, and what `--json` prints without a model, are for the step.
- When it runs: after every merge, or on demand. [Readiness question 15](../readiness-check-questions.md) puts it to the maintainer.
