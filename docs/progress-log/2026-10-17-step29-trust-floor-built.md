# Step 29: protected claims keep their policy minimum

[Pull request #144](https://github.com/melian-agent/melian/pull/144) builds the rule after the attacking review. The protected set covers every trust-boundary and tests lens claim, plus every lens `untested-behaviour` and `melian/injection-attempt` claim. All paths qualify. The proposed `trust.approvalPaths` key is dropped.

A protected lowering or refutation supplies the lesser of acknowledgement and that claim's ordinary resolution at its reported severity. It respects the same tables, ceilings and cause caps. The verifier's judgement, lowered severity and reason remain visible. Live non-speaking members supply their own minima. Dismissed context supplies none. Adjudication applies the floor before partitioning all-refuted defects, so a visible protected minimum stays counted.

Each member claim now keeps its reported severity. This prevents a refuted P3 from borrowing another sighting's P1 requirement. Default terminal and GitHub rendering explain each protected judgement, with diagnostics in JSON. Findings, verdict and publication documents rise to versions 9, 10 and 8. A fixture recorded through the previous definitions proves that reopening preserves the old verdict until a new adjudication runs, and that new diagnostics survive another reopen.

The revised contract tests first failed in 24 places and passed after implementation. Self-review then reproduced a display-only important-pre-existing lift excluding a visible protected minimum from the count. Its new test failed before the count fix and passed after it. The verifier transport leaves reported severity on its trusted labels, keeping the previous attachment-key shape. The attack's F1 advisory-table probe passes before and after: it forbids the phase-1 inversion. The hand mutation inventory and full gate results are in the builder's `tmp/step29-phase2-report.md`. The coordinator owns host mutation validation before the first full round. This pass calls no live models and changes no comparison record.

[Step 28](https://github.com/melian-agent/melian/pull/142) still owns the published status mapping. Until it lands, this acknowledgement alone does not fail that status.

Validation: 275 related tests passed. All 49 hand mutations were killed. The final whole gate exited 1 after 382.27 seconds: 4,550 passed, 53 skipped and four unchanged process-inspection failures. Three skipped supervisor tests also need `ps`. The coordinator must run the whole gate and mutation check on the host before the first full round. No dependency file changed.
