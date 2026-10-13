# surfacing-new-then-carried

Source: [the decision](../../../../docs/decisions/2026-10-12-verifier-lowers-severity-and-sets-scope.md), Goldens, surfacing: a member is new on the first revision and carried on the second.

A pre-existing P1 is a member. The first review lists it as new. `head2/` adds a comment to another file, and the second review, on the same storage, lists the same finding as carried, so it is raised once.

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
