# Step 23: the rounds decision after Codex's adversarial review

[Pull request #148](https://github.com/melian-agent/melian/pull/148), phase 1b of plan step 23, "`melian compare` reaches a merged pull request's rounds".

Codex's adversarial review found three high findings and one medium. The coordinator's rulings are now in [the rounds decision](../decisions/2026-10-18-compare-rounds-exact-rule.md), `docs/design.md` and the plan:

- A force push that hides a head is a stated limit. A range round at such a head is unattributed: export and stats list it with the count, and `--round` writes it. Melian's own loop never force-pushes a pushed commit.
- `melian compare refresh "#N" --accept` ends a retarget's deadlock. It records GitHub's new answer as a new snapshot version, and moves rejected members to an audited foreign set whose adjudications stay readable but no longer apply.
- The publish target's round ID moves into build pull request 1, with reopen tests from that pull request's own target and pending publish task at two rounds of one revision.
- Every merge base from `git merge-base --all` must share one tree; otherwise the command fails closed.
