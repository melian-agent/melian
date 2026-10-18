# Step 23: the rounds decision after its attack

[Pull request #148](https://github.com/melian-agent/melian/pull/148), phase 1b of plan step 23, "`melian compare` reaches a merged pull request's rounds".

The attack found two P1s, and [the rounds decision](../decisions/2026-10-18-compare-rounds-exact-rule.md) takes every fix it proposed:

- A round is minted where `startAdjudication` creates an adjudication task without attaching, not at triage, which several paths skip. The decision lists each path that writes a verdict and whether it mints. The adjudication commit is the only verdict writer, so it writes the round's copy.
- A range round belongs to `#N` only when its stored base equals `git merge-base B <head>`, with B the merge commit's first parent or `baseRefOid`. Reachability, the range-mode condition and base-change events are gone; legacy rounds are judged by the same equality.
- GitHub reads page by `hasNextPage`, a null `beforeCommit` is missing, and 250 or more commits fail closed.
- A `pull-request` round belongs to its stored number, and a publish target's round to its pull request. A range round whose head GitHub associates with another pull request is ambiguous and written only with `--round`.
- An undecided round does not count as the member at GitHub's head.
- A refresh that would drop a member holding an `#N` adjudication fails closed. Precedence by `at` keeps the host-clock risk, accepted in the decision.

`docs/design.md` follows. No code yet; the "For the attack" section lists the five weak points that remain.
