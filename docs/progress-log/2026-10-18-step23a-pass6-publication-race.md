# Step 23a, pass 6: bind the round publication validated

[Pull request #152](https://github.com/melian-agent/melian/pull/152) captures publication's round ID, live verdict, provenance and decision in one transaction.
After permission reads, the transaction that records the target checks the same round ID and saved verdict.
A change refuses publication, records no target and asks the maintainer to publish again.

The regression test pauses a fake permission read, mints and decides r3 through real review code, then releases publication.
Before the fix, publication posted r3. After the fix, it refuses and posts nothing.
A second test changes the saved verdict at the same round ID and proves that this also refuses.
The legacy migration fix is commit `47612f4f`.
The pass report under `tmp/step23a-pass6-report.md` records both runs, hand mutations and the full gate.
