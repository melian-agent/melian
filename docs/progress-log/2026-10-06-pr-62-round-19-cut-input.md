# Triage skips require complete input

The nineteenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) found that cut input could still authorise skipping.
The new [rule](../decisions/2026-10-06-triage-cut-input.md) disables skips for every lens when the change prompt omits diffs.
A proposed skip runs at the lowest routed level in its band.
The decision record retains the answer and records the cut; lens records explain the restriction.

The regression reproduced the old skip with a diff over 200 KiB.
It now observes a quick lens run above a floor of skip and checks the stored cut flag and original answer.
A repeated review reuses both the decision and the lens run.
