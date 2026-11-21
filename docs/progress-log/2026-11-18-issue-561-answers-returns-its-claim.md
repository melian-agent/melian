# Issue 561: a golden is scored on the claim that answered it

[Issue #561](https://github.com/melian-agent/melian/issues/561).

Codex's adversarial review of [pull request #550](https://github.com/melian-agent/melian/pull/550) at 28d05347 found that a scripted golden could pass on the wrong claim. `answers()` said whether a finding answered an expectation, and its three callers then re-derived which claim had answered. When two claims of one rule sat at different lines, `scriptedMismatches` read the first claim of the rule, not the one at the expected lines. The coordinator directed, on 2026-11-18, that the authority be fixed: `answers()` returns the claim it matched, and every caller uses that claim.

The test came first. In `packages/evals/test/goldens.test.ts`, "holds the scripted run to the claim that answered the lines, not the first of its rule" gives one finding a `lens.tests` claim at line 30 and another at line 11, and expects lines 7 to 11. At the parent commit it failed with `expected [ …(2) ] to deeply equal []`: the run compared the line-30 claim's failure scenario and evidence. With the fix, the evals and core suites pass, 4,240 tests.

Core gains `Finding.claimAs(source)`, the claim a finding makes as one check that reported it: the copy a merge kept, or the finding's own fields. `claims()` now reads through it. The scoring callers test the returned claim for `undefined`, and `scriptedMismatches` reads the failure scenario and evidence from it. Seven test fakes that were bare literals are now wrapped in `Finding.from`, since the scoring code calls a method on them.

The change runs on scripted goldens only; the issue holds the measurement code to tests, without a hand mutation proof.
