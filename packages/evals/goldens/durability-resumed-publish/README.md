# durability-resumed-publish

Seeded from finding A3 of the [comparison record](../../comparisons/2026-10-03-pr-19.md) for [pull request #19](https://github.com/melian-agent/melian/pull/19): `publishReview` resumed every publish task a crash left, so a publish interrupted before its post, followed by a retarget that kept the head, posted the review of the old diff. The head adds that resumption to a `publishReview` that validated only its own call.
