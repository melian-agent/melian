# [Issue #496](https://github.com/melian-agent/melian/issues/496): the review of record's three findings

The review of record on [pull request #530](https://github.com/melian-agent/melian/pull/530) at fe8114a0 found three things.

- The five mutation inventories did not pass the sampler's schema: evidence was a joined string, and rows carried `run` and `result` fields. They now use the version-2 form, and each samples cleanly.
- A telemetry stage's model string carried the reasoning level the provider reported, which is provider text. Run details now name that level only when it is one of Pi's levels, checked against core's `thinkingLevelSchema`, and write `unrecognised` otherwise. A test in `packages/pipeline/test/reasoning-telemetry.test.ts` failed on the head with `(reported sk-live-token)` and passes after the fix.
- Two producers of one check whose versions were both withheld shared a key, and the later one's finding IDs replaced the earlier's. An account now unites their IDs, and a producer that counts every finding makes the united one count every finding. Two of the three cases in `packages/pipeline/test/review-records-withheld.test.ts` failed on the head with an assertion error, and all pass after the fix.

A run details record that an earlier build stored keeps the level as it wrote it.

Mutation proof: `2026-11-16-issue-496-review-of-record-mutants.json` lists the 22 mutants of both fixes. All 18 generated mutants were killed, each by its named test run alone after that test passed unmutated. Two survived the first run, dropping the sort of the united IDs and keying producers by `version && ""`; the test's IDs now arrive out of order, and a new test keeps two kept versions apart. The telemetry fix has no generated mutant; forcing its level check to `true` and to `false` by hand each failed the new test. Four string literals are ignored by configuration.
