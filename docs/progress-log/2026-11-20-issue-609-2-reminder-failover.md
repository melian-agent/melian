# A reminder fails over too, and a later failure keeps the refusal before it

[Issue #609](https://github.com/melian-agent/melian/issues/609), the fix pass on [pull request #619](https://github.com/melian-agent/melian/pull/619) for two review findings.

Codex's adversarial review found that a reminder never moved on. A reminder is the turn that asks a planner for the plan it did not record, or a prober for the attacks it left unanswered. It went to the model that had answered, and any failure, a content filter's refusal included, failed the lens though a fallback was free. A reminder now runs through the same loop as the conversation's first input. It starts at the model that answered and moves along the same route. It keeps its own request ID, `lens:<key>:plan` or `lens:<key>:answer`, adds `:<attempt>` only for a model it moved on to, and counts its moves in the checkpoint under that ID. A usage limit on a reminder now moves it on too, since every failover error does.

The review of record found that a lens whose first model refused, and whose next failed in a way that does not move on, recorded `the lens did not finish` and lost the refusal. That record now reads `the lens did not finish; <model> refused the content`, in the form a lens whose every model failed already used.

The fix commits:

- `14f91c3ea` names a refusal when the next model then fails without moving on.
- `de9d5c6af` moves a planner's or a prober's reminder to the next model when it fails over.
- `ab5ac9822` adds four tests for the mutants the first two left alive.

The tests were written first. Before the fix, both reminder tests failed with `ReviewError: lenses did not finish: trust-boundary`. The test built from the reviewer's probe failed with `"reason": "the lens did not finish"` where `"the lens did not finish; faux/first refused the content"` was expected. After the fix, `probing-level.test.ts` passed 164 of 164, and the pipeline suite passed 3,972 tests and skipped 5.

`review.ts` guards trust: it decides which model reviews a change and what the lens's record says of it. `harness.ts` did not change. [The inventory](2026-11-20-issue-609-fix-mutants.json), from `melian mutants list 4b691eab6...de9d5c6af --claims-in packages/pipeline/src/review.ts`, lists 90 mutants: 73 generated and 17 ignored by configuration. A scratch runner applied each generated mutant and ran its named test alone, after that test passed unmutated. The results:

- 65 killed by an existing test. Two of these, `at >= attempt` and `at--` in the loop over earlier attempts, never end, so the named test hit its timeout. One, `outcome.refused` without its optional chain, throws in `run-stands.test.ts` on a run with no outcome.
- 7 killed by the four tests `ab5ac9822` added. They pin the reminder's request IDs, its checkpoint counter beside the conversation's, the refusals it carries from before it, and the last model's own words when every model refused it.
- 1 equivalent: `at <= attempt` reads one more settled attempt, which never adds a refusal. It survived the whole pipeline suite of 3,981 tests, and its reason is in the inventory.

No key moved. The identity guideline's row for a lens run key still holds: a reminder's first request ID is unchanged, and a later attempt adds to it.

Timing: mutants 1 × 91 min; mutants 1 × 4 min (the survivors' named tests); mutants 1 × 10 min (one survivor against the pipeline suite).
