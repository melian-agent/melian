# Stryker leaves this repository's review rounds

Amends: [a guard counts as tested only when a failing mutation proves it](2026-10-07-tested-means-a-failing-mutation.md), scoped to how the proof is produced in this repository.

Choice: from 2026-10-24, the `full` tier in this repository's `melian.yaml` no longer names `static.mutation`. The `static.mutation` settings block stays, so a reviewer can opt in with `tiers: { full: [static.mutation] }` in an uncommitted `melian.local.yaml`. The product's check is unchanged; the design on branch `mutation-evidence-design`, which adds `melian mutants list` and `melian mutants verify`, decides its future.

Interim rule: until `melian mutants verify` lands, the proof that a changed guard is tested is the builder's enumeration-first inventory from `scripts/enumerate-mutants.mjs`. The builder runs its sampled probes by hand and records them. A fix pass enumerates its own commits' mutants and runs every sampled probe before pushing. Lens `untested-behaviour` findings keep their severity. The rule that a guard counts as tested only when a failing mutation proves it is unchanged.

Why: six passes from 2026-10-22 to 2026-10-24 showed the inventory claims held when the sampled probes were run. Stryker rounds cost an hour or more and read `not reviewed` when they ran past their timeout. The tested-means decision's proof is the failing mutation, and the inventory with its probes produces it without the whole-suite run.
