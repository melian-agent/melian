# scope-no-named-trigger

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, scope: a proposal with no named trigger.

The change edits a comment, and every other check would hold. The verifier names no trigger. Both things the rule cannot see fail toward not re-scoping only when a trigger is named, so a proposal without one is refused.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
