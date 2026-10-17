# Test the final round's exact publication mutants

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 4, adds two direct regressions.
The dismissal renderer test fails when the reported condition becomes true and drops the dismissal section.
The retirement test fails when the reported condition becomes true and deletes another finding's owed thread resolution.
Both pass after restoration. The combined restored run passed 48 tests.

The round's third replacement is `before.rounds`, removing the optional access from `before?.rounds`.
It is equivalent: the status commit creates the head record before the loop reads `before`, and the single writer never deletes it.
The exact replacement passed the publication-planning recovery cases.
The earlier arithmetic kill tested a different mutant and did not prove this one killed.
The coordinator must adjudicate this equivalence. The four earlier provider equivalents remain unchanged.

Exact replacements, failing output, restored output, gate results and CI are in `tmp/orphan-thread-pass4-report.md`.
No production code, design decision or plan status changes in this test pass.
