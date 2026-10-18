# Step 23: the rounds decision after its second attack

[Pull request #148](https://github.com/melian-agent/melian/pull/148), phase 1b of plan step 23, "`melian compare` reaches a merged pull request's rounds".

The second attack held [the rounds decision](../decisions/2026-10-18-compare-rounds-exact-rule.md) with changes, and the decision takes each:

- Legacy rounds come from every key that holds a verdict or a comparison; a key with no verdict is an undecided round, so `main`'s orphaned comparisons stay reachable.
- An unreachable member stays in the snapshot, marked so. A refresh fails closed only when a rule now rejects an earlier member.
- A fast-forward merge, whose merge commit's first parent is one of the pull request's commits, fails closed and names the cause; `--round` still writes.
- The minting commit deletes the live verdict, provenance and decision, as triage does.
- Legacy rounds number before minted ones, by their head's commit date.
- Membership tests the stored base against `git merge-base --all`.
- The legacy-first record is read and written in the writer's transaction. A reopen test has a task `main` left pending write its key's legacy round, overwriting its verdict as `main` did.

The decision and plan step 23 gain the build plan: four stacked pull requests, from about 6,300 changed lines. `docs/design.md` follows.
