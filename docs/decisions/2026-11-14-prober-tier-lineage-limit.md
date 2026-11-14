# A prober on a tier of its own is missing from its check's lineage

Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), its "What it gives up"

Status: the coordinator asked on 2026-11-14 for this limit to be recorded, and for [issue #438](https://github.com/melian-agent/melian/issues/438) to hold the fix, after the Actions round on [pull request #296](https://github.com/melian-agent/melian/pull/296) at `12423ddb` raised finding `21afe8aa23e08c62`. It is an acknowledge finding, and the coordinator has asked the maintainer to read it. Nothing here is a ruling of the maintainer's.

Problem: a check's lineage names the models its lens finished on, so a reader can see when a run left its committed route. A level that probes runs a planner and a prober. When the prober runs on its level's own tier, its finished model joins the lineage. When it runs on a tier of its own, set by `probe.prober`, it does not.

Example: a level on `heavy` sets `probe.prober: medium`. The planner finishes on heavy's model A. The prober's primary B is overloaded, so it fails over to C, which `medium` accepts, and it reports a finding. The verifier is chosen against C, but the lens check's lineage names A alone. The stored check record, the JSON verdict, the rendered review and the ledger say nothing of C.

Choice: this is a limit, not a fix. The verdict is unaffected: the prober's route holds only its own tier's accepted models, so it never runs on a model that tier refuses. The lineage leaves out which accepted model ran. A fix has to let the record `plan.mark` judges carry the prober's tier beside its model, so that each model is judged by its own tier's committed policy. As it stands, `plan.mark` would judge the prober's model by the level's tier and could fail a model the prober's own tier accepts. That is a new field in the check record, and issue #438 tracks it.
