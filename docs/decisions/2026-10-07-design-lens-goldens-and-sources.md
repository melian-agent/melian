# The design lens owes one golden per rule, and each rule has a recorded source

Choice: the `design` lens owes nine goldens, one per rule, and no longer owes each with Codex as its source. It declares the single level `careful`. Each rule maps to the comparison record finding it came from.

Why: the decision said each golden would have Codex as its source. A golden is a case a lens must catch, and a case needs a written scenario, not a reviewer. One per rule is the measure that matters. Codex found the original defects, so the sourcing claim added nothing a golden can test.

The rules come from these findings. In [pull request #85](https://github.com/melian-agent/melian/pull/85), A1 gives `identity-missing-input`, A2 `trust-by-label`, and A3 `bound-on-wrong-measure`. In [pull request #86](https://github.com/melian-agent/melian/pull/86), A1 gives `resumed-identity`, A2 `fail-open-default`, and A3 `criterion-selection-bias`. The record for [pull request #89](https://github.com/melian-agent/melian/pull/89) sits in [pull request #90](https://github.com/melian-agent/melian/pull/90), and A1 gives `unshipped-artifact` and A2 `single-slot-overwrite`. `capability-by-class` is drawn from the adversarial review threads and has no record yet.

The lens declares only the `careful` level, with `reads: functions` and `verify: true`, on the heavy tier, and no `quick` or `deep`. The schema requires `careful` and makes the others optional. A cheaper variant would read hunks, and the defects here live outside the hunk: the key whose missing input is declared three files away, the manifest a `files` list does not ship, the decision a changed default quietly reverses. A lens that cannot read the enclosing function and the decision beside it cannot see them, so one level, at the full cost, is the honest declaration.

The lens prompt does not carry the rationale for its front matter. [Pull request #93](https://github.com/melian-agent/melian/pull/93) moved it out of the prompt, so the model reads rules and not the reasons for its own configuration. This file holds it.

Supersedes: [2026-10-07-design-lens.md](2026-10-07-design-lens.md), only in that the goldens are owed one per rule rather than each with Codex as its source, and in the points above.
