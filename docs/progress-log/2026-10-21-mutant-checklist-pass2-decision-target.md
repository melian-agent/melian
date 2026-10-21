# Entry-kind amendment targets the active mutation decision

[Pull request #165](https://github.com/melian-agent/melian/pull/165), pass 2 validation follow-up.

CI at `8a4b67f7` rejected the entry-kind amendment because its mutation-testing target was inactive. The existing written-decision test reproduced that failure locally. The amendment now targets the active as-built successor, which restates the source-selection contract. The report records the passing run after this commit; the test reads committed decisions.

The three review fixes are `d3662bd8` (trusted checkout wording), `8a4b67f7` (regular head entries), and `d83c7933` (reproducible sampling). The complete pass inventory has 172 mutants with none omitted. All new guards were hand-mutated. The final sampler selected 48 probes: 47 kill claims failed named tests and one configured encoding mutation is equivalent. Restored script suites pass 66 tests. The report holds the full gate, CI and sandbox-denial results.
