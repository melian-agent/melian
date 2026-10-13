# conflict-replay-after-each-report

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, conflict: a replay after each report.

The verifier makes each of two reports twice, as a replayed tool call does: the lowering, the lowering again, the plain one, the plain one again. The guard runs in each report's commit, so a repeat changes nothing and the plain report still wins the equal verdict.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
