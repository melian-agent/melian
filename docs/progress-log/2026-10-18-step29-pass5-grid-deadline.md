# Step 29 pass 5: keep the outcome grid within each test’s deadline

[Pull request #144](https://github.com/melian-agent/melian/pull/144) splits the outcome grid after CI timed out on Node 24 and 26.
The two large tests become eleven: three protected kinds and eight merged policy tables.
Each runs 768 cases. All 8,448 cases and both merged report orders remain; no timeout is raised.
The targeted run passes 119 tests in 3.11 seconds, and type checking passes.

The commit also formats two test blocks missed in the preceding check.
The fresh importance list reads a decision just written on every entry, so it uses that invariant without an unreachable optional-chain guard.
No behaviour, stored shape or plan status changes. The final whole gate and exact CI head are recorded in `tmp/step29-pass5-report.md`.
