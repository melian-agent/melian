# Step 23a, pass 7: round publication findings

[Pull request #152](https://github.com/melian-agent/melian/pull/152) corrects the publication guideline for finding `98e53c595a2c8acc` and advisory `7f48924901966b22`. Older targets bind transactionally only when their revision has no minted round. Every bound target reads its round’s saved verdict. A missing copy refuses publication.

This fix pass leaves the implementation plan and existing decisions unchanged.

Finding b43d6418115c7274 now has direct tests for plain and open historical text, plus current-output controls. The first run exposed a generic dismissal command in the historical verdict header. Historical rendering now omits that instruction too. The restored run passes 100 tests. Appending the agent prompt to either historical branch fails its test. Removing either current prompt also fails. Removing the historical rendering flag or guard, or inverting its assignment, fails.

The installed Stryker 10.0.0 instrumenter enumerated six exact replacements at the two publication locations. Four fail direct tests, including a new missing-publisher-target case. Two are equivalent: the publisher is assigned before its optional access, and the earlier transaction opens the rounds document before its snapshot. Finding 644f4829ed4a570e retains its pass-5 equivalence: the earlier verdict guard rejects an absent round before round.stored is reached.

Finding 410e116da7f2a237 is reproduced before the fix. A real child is killed with the passing r1 publish task committed and its phase parked before any verdict read. A review-only harness then records blocking r2 while leaving the publisher target at r1. Reopening PublishHarness originally published r1. The task now checks the rounds document before starting the provider session. It ends superseded when its target is no longer current or lacks a saved verdict.

Direct tests cover both legacy and minted targets superseded by an undecided round, missing current-round pointers, and missing saved rounds or verdicts. Current targets still read their saved verdict after the live copy is deleted. Nine hand mutations of the guard, its early return and its missing-round reason fail. Calling an absent optional provider session hook also fails its direct test. No stored version changes.

The whole gate was rerun after correcting two test-only type errors. It exits 1: 4,954 tests pass, 53 skip and four fail. Three report ps failed: undefined; the supervisor test returns toolFailed instead of invalidOutput. These match the known sandbox failures. No timeout occurred. Lint, dependency checks, TypeScript and the audit threshold pass. The host must rerun the whole gate.
