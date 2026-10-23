# 2026-10-23: step 10, the required status, is done

On 2026-10-23 the maintainer created ruleset 25714853, `melian-review`, on `refs/heads/main`. It requires the `melian/review` status and has no bypass actors. Ruleset 24413134 (`check (22)`, `check (24)`, `check (26)`, resolved review threads, and the merge queue with ALLGREEN and MERGE) is unchanged. The effective rules on main now hold both.

The prerequisites landed first:

- Advisories sit in the review body only: [pull request #167](https://github.com/melian-agent/melian/pull/167).
- The merge-group workflow and `melian status merge-group`: [pull request #168](https://github.com/melian-agent/melian/pull/168), with [pull request #171](https://github.com/melian-agent/melian/pull/171).
- The design-file read limit that let Melian review this repository again: [pull request #174](https://github.com/melian-agent/melian/pull/174).
- The outage procedure: [pull request #172](https://github.com/melian-agent/melian/pull/172).

The merge groups of #174 and #172 were the first live `success` runs of the workflow: "reviewed head and base verified", posted by `github-actions[bot]`. The readiness check (2026-10-21) and the rehearsal on [pull request #164](https://github.com/melian-agent/melian/pull/164) are done. The scratch-repository test of the two ruleset layouts is the decision #172 records.

Still open from step 10: the retirement line in `melian compare stats`, and [issue #173](https://github.com/melian-agent/melian/issues/173), a validated `melian status override`.
