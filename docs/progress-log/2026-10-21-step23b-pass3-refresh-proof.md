# Step 23 build 2, pass 3: prove the read refresh

[Pull request #162](https://github.com/melian-agent/melian/pull/162) now tests a comparison whose own round's verdict changes.
The detached reader removes stale Melian IDs and site matches in memory, while the stored comparison stays unchanged.
Inverting the refresh guard fails this test.
This covers the earlier guard whose callback moved when export ordering changed.
The address tests also name their parsed fixture types, and the public API comments describe unattributed selection.

The first full gate passed formatting, types and dependency checks, with 5,516 tests passing and 53 skipped.
Four mutation-process tests failed because the Codex sandbox denies `ps`; three report that denial directly, and the supervisor probe uses `ps` before signalling its parent.
These are sandbox failures, not a reason to stop the pass.
A host gate and the static mutation check remain necessary.
