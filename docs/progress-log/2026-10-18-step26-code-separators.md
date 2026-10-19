# Step 26: keep code separators inside their clause

A final probe on `a3ff61c7` for [pull request #150](https://github.com/melian-agent/melian/pull/150) found that Unicode NEXT LINE inside an inline-code span split one clause into two. The mask covered sentence-terminal punctuation but left this control separator visible to Intl.Segmenter.

The regression test failed first: the parser returned two clauses instead of the asserted whole sentence. The mask now covers punctuation and control separators while preserving letter case, combining marks, format characters and UTF-16 offsets. This implements the existing rule that inline code stays whole; no decision or plan status changes.

The targeted parser and notice suite passed 65 tests. Restoring the earlier sentence-terminal mask made the new test fail again. Logs and the mutation inventory are under tmp/step26-phase2-*. No existing asserted outcome changed.

Whole gate rerun: lint, dependencies, types, the audit threshold and 4,906 tests passed, with 53 skipped. Four existing process tests failed on the same ps-denial sandbox restriction. No timeout occurred. The coordinator must rerun the whole gate on the host. No live model or review ran. The coordinator retains the host gate and cold mutation check.
