# Step 23a, pass 6: refuse ambiguous old publication tasks

[Pull request #152](https://github.com/melian-agent/melian/pull/152) now checks stored rounds before binding an old target.
An unbound task beside a minted round at its revision ends superseded and posts nothing.
Storage without a minted round at that revision still binds the legacy round.
The check and binding share one transaction. Publication reads only the bound round's saved verdict.

A fixture recorded by build 1's real review code creates a pending task after r2, then decides r3.
Its reopen test failed before the fix: the old task published. It passes after the fix.
The two-round fixture has the same refusal; the main fixture still migrates and posts.
Tests also cover an unrelated revision's minted round and a bound legacy task after the live verdict is deleted.
Legacy migration assertions now leave task inputs unbound until the transactional check.
Existing dismissal fixtures write their round copy through `RoundWriter.record`, alongside the live verdict.
Their publication, recovery and trust-floor assertions stay unchanged.
The pass report under `tmp/step23a-pass6-report.md` records hand mutations and the full gate.
