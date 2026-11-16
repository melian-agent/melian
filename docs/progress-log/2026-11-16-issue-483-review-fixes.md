# [Issue #483](https://github.com/melian-agent/melian/issues/483): fixes from the first reviews

Three review findings on [pull request #490](https://github.com/melian-agent/melian/pull/490) changed the per-lens probing wording, each with a test that failed first.

- Codex's first review found that the `correctness` wording counted any throw as a defect, though code that refuses an input it does not accept is right. Its plan, prober and judgement now count a throw only where a result is expected (bd8a4c97).
- The first Melian round found that no test held each lens's planner to its own words for earlier findings. `probing.test.ts` now does (253199ce).
- Codex's second review found that a `tests` probe exited 0, the passing outcome, when its test already failed on the unchanged copy, so a broken test read as one that covers the change, and could refute a carried finding. Such a probe now prints what the test printed, exits 125 and reports no finding. A fake-model test shows that its refutation is refused and the verdict holds no finding. Melian still counts the attack as answered, so no level may probe with the `tests` lens before [issue #493](https://github.com/melian-agent/melian/issues/493).
- The second Melian round found that no test held a planner's reminder to its own lens's words. A fake-model test now has a `tests` planner record no plan at first, and checks that its reminder is the `tests` lens's own `recordPlan`. With `recordPlanPrompt("trust-boundary")` at `review.ts:635`, the round's mutant, it fails.
