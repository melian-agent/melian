# Step 23b pass 2: pull-request writes and export headings

[Pull request #162](https://github.com/melian-agent/melian/pull/162) answers Codex's two other findings.

A comparison write with `--round` now refuses a pull request's round before any store opens. `compare`, `match`, `unmatch` and `adjudicate` each exit 1 and say `#N` writes come later; `findings --round` still reads the round. The inverted CLI test failed on the old head with exit 0 for the first write, and passes now. Removing the guard leaves a comparison in the pull request's store, which the test reads back; inverting it fails 11 tests.

Export headings print each entry's stored round ID. Before the fix, an earlier unattributed comparison made the only round read "round 2", and comparing r2 before r1 swapped their names; both new tests failed that way. An entry with no round, built only in memory, is named by its revision. Five hand mutations of the label each fail at least one test. Five existing expectations of "round 1", the golden `comparison.md` among them, changed on purpose to the stored ID.

The snapshot fix in 6ace61f8 was checked again: its interleaving test fails with the fix reverted, with the legacy comparison read as unattributed. No stored shape or plan status changes.
