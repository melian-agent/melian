# A prober on a tier of its own is missing from its check's lineage

Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), its "What it gives up"
Amends: [Restore the review plan and credential clauses](2026-11-08-restore-credentials-clauses.md), "A check records lineage on the model its lens finished on", for a prober on a tier of its own

Status: the coordinator asked on 2026-11-14 for this limit to be recorded, and for [issue #438](https://github.com/melian-agent/melian/issues/438) to hold the fix, after the Actions round on [pull request #296](https://github.com/melian-agent/melian/pull/296) at `12423ddb` raised finding `21afe8aa23e08c62`. It is an acknowledge finding, and the coordinator has asked the maintainer to read it. Nothing here is a ruling of the maintainer's.

Problem: a check's lineage names the model its lens finished on, so a reader can see when a run left its committed route. [The lineage rule](2026-11-08-restore-credentials-clauses.md) records it when a preference file, `--model` or a derivation moved the tier off its committed model, inside `accept` or outside it, and whenever the model is outside `accept`. A level that probes runs a planner and a prober. When the prober runs on its level's own tier, the rule covers it. When it runs on a tier of its own, set by `probe.prober`, the check's lineage covers the planner alone.

Example: a level on `heavy` sets `probe.prober: medium`. A maintainer's `melian.local.yaml` moves `medium` from its committed model B to C, which `medium`'s `accept` holds. The planner finishes on heavy's committed model A, so its lineage records nothing. The prober runs on C and reports a finding. The rule wants C recorded, marked inside `accept`, with `melian.local.yaml` as what put it there. Nothing records it.

Choice: this is a limit, not a fix. For a prober on a tier of its own, the lineage rule does not yet hold. The stored check record, the JSON verdict, the rendered review and the ledger name neither the prober's model, nor the model its tier wanted, nor the file, flag or derivation that moved it. The planner's lineage is recorded as before.

The same holds for a prober that falls back outside its tier's `accept`, where that tier's policy allows it.

The verdict is unaffected, because the prober's own tier's policy decides where it may run. The plan refuses a prober whose tier the policy refuses, and under `acceptOverridden: false` it keeps only that tier's accepted models in the prober's route, as [the probing level](2026-11-07-trust-boundary-level-that-probes.md) says. So the prober runs only where its tier's policy allows. What is missing is the record of which model ran, and why.

A fix has to let the record `plan.mark` judges carry the prober's tier beside its model, so that each model is judged by its own tier's committed policy. As it stands, `plan.mark` would judge the prober's model by the level's tier, and could fail a model the prober's own tier accepts. That is a new field in the check record, and issue #438 tracks it.
