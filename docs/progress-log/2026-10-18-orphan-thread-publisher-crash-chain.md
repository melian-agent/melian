# Prove publisher changes across two process kills

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 9c, after `4b0c7360`.

The crash test kills Alice's process before GitHub accepts the review.
Bob resumes, supersedes Alice, journals his own login and posts. A second kill precedes the publication checkpoint.
Carol then resumes against the same SQLite store and recovers Bob's personal-author review.
The test requires one accepted review and one review POST from Bob onwards, with no Carol repost.
Alice and Bob both end superseded. Current status attribution names Carol while recovery still accepts Bob.

With all three original production files restored from `dbeec2f4`, the test failed: the pending ledger still named Alice after Bob posted.
It passes with the publisher rule. Both runs are retained in the pass report.
The parked child now exits after 30 seconds if its parent disappears; the parent kill deadline remains 15 seconds.

The complete mutation inventory has 164 hand runs: 152 killed and 12 equivalent.
The earlier whole gate passed 4,872 tests and failed four existing process tests in the sandbox.
The final pass reruns the whole gate and records its result in `tmp/orphan-thread-pass9c-report.md`.
No existing test outcome changed outside the coordinator's exceptions.
The implementation plan stays unchanged for this fix pass.
