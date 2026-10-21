# Thinking routes: merge main

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 8, merges main at `433dc6cd` with a merge commit.
It brings the orphan-thread returns from [pull request #155](https://github.com/melian-agent/melian/pull/155) and Vite 8.3.4 from [pull request #160](https://github.com/melian-agent/melian/pull/160).

The only conflict was in the ledger migration test's stored-version assertions.
Both assertions remain: verdict version 12 from this branch and published version 9 from main.
Every other test and assertion from both parents remains intact.

The document and task version audit found no collision.
Verdicts stay at 12, adjudication at 5, lenses at 4, and verification and summarisation at 2.
Publication takes main's document version 9 and keeps task version 6.
Triage measurement JSON stays at version 3.
Existing fixtures recorded by production code cover the earlier shapes and remain in the reopen tests.
This pass adds no production branch or migration.

No decision or step status changes.
The pass report under `tmp/m2/scratch-thinking/thinking-routes-pass8-report.md` records the version table, validation, sandbox denials, commit and push.

The first whole gate passed through the audit and ran all 5,503 tests.
It passed 5,446, skipped 53 and failed on the same four sandbox cases as pass 7.
Three explicitly report a denied `ps`; the mutation supervisor test reports `toolFailed`.
No timeout or other test failure occurred.
