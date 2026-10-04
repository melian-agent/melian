# durability-superseded-write

Seeded from finding A3 of the [comparison record](../../comparisons/2026-10-03-pr-16.md) for [pull request #16](https://github.com/melian-agent/melian/pull/16): a superseded adjudication still wrote its verdict after a process kill. Recast on a new walkthrough task: the change names each walkthrough task in the review index, as adjudication does, but the task's final commit never checks that the index still names it, so a task a crash left behind writes the walkthrough of an old verdict over a newer one.
