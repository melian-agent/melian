# Preserve GitHub's nullable parent-review link

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 4, follows Octokit's nullable parent-review ID.
The initial record validator wrongly treated null as malformed and blocked a listing that also held a valid owned root.
The new regression fails with the incomplete-page error before this correction.
It now accepts the page, recovers the owned root and grants no ownership to the human root with a null review link.
Missing, non-numeric and unsafe parent IDs still reject the listing.

One initial negative test expected null to fail. That expectation was wrong and is replaced by this positive case.
The earlier record-validation progress entry describes the stricter intermediate code; this entry records its correction.
The installed pull-request-review-comment schema permits null; the ownership rule still requires a verified parent review.
The restored provider and address run passes 98 tests. Both constant replacements of the nullable-parent branch fail.
The final whole gate and exact-head CI are in `tmp/orphan-thread-pass4-report.md`.
