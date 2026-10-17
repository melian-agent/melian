# Prove the publication planning survivors

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 3, extends the exact mutation inventory from `16237d37`.

The pipeline regressions kill the host's three replacements: carrying every resolution, subtracting from the next round, and probing threads for findings that have not returned.
The carry tests also kill removal of each side of its condition.
They cover a reopened report merged under another finding and a changed dismissal whose current answer is already journalled.
The round tests check the discovery request, including the first round and a head with two earlier planned rounds.
The thread test proves that an unrelated owed thread is read after the review posts.

An extra optional-chain probe on the round lookup is equivalent: the preceding status commit always creates that head's publication record.
The local `tmp/orphan-thread-equivalents.md` gives the proposed equivalences for coordinator adjudication.
The running inventory in `tmp/orphan-thread-pass3-report.md` records each exact replacement, failing output and restored run.
It appends to the earlier inventory rather than treating a killed line as proof of every mutant there.
No production behaviour, stored shape, dependency or design decision changed. The plan stays unchanged for this fix pass.
No live model calls ran.

The full gate did not pass in the sandbox: 4,622 tests passed, 53 skipped, and four existing tests failed because `ps` is denied.
There were no timeouts. Formatting, type checking, dependency checks and the high-severity audit gate passed.
All new tests passed. The local report names the four failures and the three tests the `ps` probe skips.
The coordinator must run the whole gate and mutation check on the host.
