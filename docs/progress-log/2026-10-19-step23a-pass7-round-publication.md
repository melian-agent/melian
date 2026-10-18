# Step 23a, pass 7: round publication findings

[Pull request #152](https://github.com/melian-agent/melian/pull/152) corrects the publication guideline for finding `98e53c595a2c8acc` and advisory `7f48924901966b22`. Older targets bind transactionally only when their revision has no minted round. Every bound target reads its round’s saved verdict. A missing copy refuses publication.

This fix pass leaves the implementation plan and existing decisions unchanged.

Finding b43d6418115c7274 now has direct tests for plain and open historical text, plus current-output controls. The first run exposed a generic dismissal command in the historical verdict header. Historical rendering now omits that instruction too. The restored run passes 100 tests. Appending the agent prompt to either historical branch fails its test. Removing either current prompt also fails. Removing the historical rendering flag or guard, or inverting its assignment, fails.

The installed Stryker 10.0.0 instrumenter enumerated six exact replacements at the two publication locations. Four fail direct tests, including a new missing-publisher-target case. Two are equivalent: the publisher is assigned before its optional access, and the earlier transaction opens the rounds document before its snapshot. Finding 644f4829ed4a570e retains its pass-5 equivalence: the earlier verdict guard rejects an absent round before round.stored is reached.
