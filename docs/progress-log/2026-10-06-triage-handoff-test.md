# Skipped lens hand-offs

[Pull request #62](https://github.com/melian-agent/melian/pull/62) now tests the hand-off boundary after triage skips a lens.

The pipeline regression first runs correctness and contracts together and checks that correctness's model instructions name the contracts hand-off. A recorded decider then runs correctness at careful and skips contracts. The test checks the skip record, confirms contracts received no model request, and checks that correctness's rendered instructions no longer name contracts. Both reviews use memory storage and the fake provider.

All 65 tests in the triage file pass. Temporarily including skipped lenses in the neighbour list makes this regression fail because correctness's instructions still name contracts. The filter was restored before the gate.

This closes a test gap in the existing neighbour filter. It changes no review behaviour or design decision.
