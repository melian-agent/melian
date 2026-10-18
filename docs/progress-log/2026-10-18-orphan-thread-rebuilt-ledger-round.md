# Preserve posted-round numbering in rebuilt ledgers

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 9c, after `65e27cfb`.

A legacy pending round can lack a ledger after an abandoned attempt.
One posted review followed by attempt three must produce ledger round two.
The new boundary case failed with `ledger round counts posted reviews: expected 3 to be 2`.

The rebuild now takes the number from the record's accepted reviews, as normal planning does.
All 34 publication-planning tests pass.
The installed Stryker subtraction mutant, a constant-one mutant and a return to attempted-round numbering each fail.
The test covers zero and one accepted review, including the gap after an abandoned attempt.

The whole gate's earlier four process failures remain sandbox limitations; the final pass reruns the whole gate.
Evidence and the mutation inventory are in `tmp/orphan-thread-pass9c-report.md`.
The implementation plan stays unchanged because this preserves the existing ledger rule.
