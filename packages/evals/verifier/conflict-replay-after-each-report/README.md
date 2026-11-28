# conflict-replay-after-each-report

Source: [the decision](../../../../docs/decisions/2026-10-13-re-scope-held-for-the-compiler.md), Goldens, conflict: a replay after each report, as [the first-report decision](../../../../docs/decisions/2026-11-28-a-claims-first-report-stands.md) amends it.

The verifier makes each of two reports twice, as a replayed tool call does: the lowering, the lowering again, the plain one, the plain one again. The guard runs in each report's commit. The repeated lowering is the stored report again, so it is taken and changes nothing. Each plain report has an equal verdict, so it is refused and says why, and the first report's lowering stands.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
