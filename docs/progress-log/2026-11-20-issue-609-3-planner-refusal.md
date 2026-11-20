# A planner's refusal stays on the record when its prober then fails

[Issue #609](https://github.com/melian-agent/melian/issues/609), the second fix pass on [pull request #619](https://github.com/melian-agent/melian/pull/619), for Codex's second adversarial review.

Codex found that a probing run lost its planner's refusal when the prober failed. Say the planner's first model refused the content, its second wrote the plan, and the prober then failed in a way that does not move on. The record read `the lens did not finish`, with nothing about the planner. A planner whose answering model recorded no plan lost the refusal the same way. Both leave `probe()` through one return in `run`, so the fix goes there. A probing failure now carries the planner's refused models and the model that answered as `planner`. The record names them as a finished lens's record does: `the lens did not finish; for its planner, <a> refused the content, so <b> answered`.

This is the second round in a row to find a refusal lost on a later failure. The review of record's R1 was the first. The class is a conversation's refusals dying at the boundary to the next step. A lens has two such boundaries, one from a conversation to its reminder and one from the planner to the prober, and each now carries the refusals across.

The fix commit is `63bdce3d1`. Its two tests were written first. On the head before it, both failed with `"reason": "the lens did not finish"` where `"the lens did not finish; for its planner, faux/first refused the content, so faux/second answered"` was expected. After it, `probing-level.test.ts` passed 170 of 170.

[The inventory](2026-11-20-issue-609-3-planner-refusal-mutants.json), from `melian mutants list ca67dff70...63bdce3d1 --claims-in packages/pipeline/src/review.ts`, lists 16 generated mutants. A scratch runner applied each and ran its named test alone, after that test passed unmutated. All 16 were killed: 8 by the new test of the prober's failure, and 8 by existing tests. One of them, `planned.refused === undefined` set to `false`, was first run against the new test, which it survives, since it only adds an empty `planner`. The pipeline suite then failed in 8 tests that assert a failed outcome whole. Its claim rests on one of them, `fails a lens whose prober's every model failed, naming them`, which killed it alone.

Timing: mutants 1 × 9 min; mutants 1 × 2 min (two reruns); other 1 × 6 min (one mutant against the pipeline suite, to find its test).
