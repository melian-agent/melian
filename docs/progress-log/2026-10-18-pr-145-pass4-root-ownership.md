# Bind finding roots to signed parent reviews

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 4, rejects copied finding markers in human-started reviews.
Seven initial probes failed before the fix: five recovered a foreign root, and two edited and resolved it.
Discovery now checks the parent review's ID, signed verdict marker, revision and author.
An unavailable `/user` grants no ownership.
The first verified review establishes an unknown publisher, so a later copied review by another author is ignored.
Addressed edits verify the parent review before editing or resolving the signed root.

Hand-seeded test roots now include their signed parent reviews.
The decision's as-built section and design describe the ownership proof and added review read.
Exact mutations, red and restored runs, the whole gate and CI are recorded in `tmp/orphan-thread-pass4-report.md`.
No comparison record or plan status changes in this fix pass.
