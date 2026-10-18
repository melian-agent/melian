# Step 26 pass 3: supersession lookup coverage

[Pull request #150](https://github.com/melian-agent/melian/pull/150).

Direct SupersessionReview tests distinguish an untouched successor from an unrelated rename, keep an unrelated rename out of the target baseline, and assert the empty notes contract. All 40 supersession tests pass after restoration. Production behaviour is unchanged.

Fifteen of the sixteen exact installed instrumenter mutants fail. The true changed-file lookup first survived without an unrelated rename. Adding that rename exposes the wrong oldPath and kills it. Finding `5b964f225dc56331` has one equivalent replacement: forcing the oldPath conditional false adds undefined before the current path; the next decision-path filter rejects undefined. The appended inventory names each replacement and failing test. The final pass report records the whole gate.
