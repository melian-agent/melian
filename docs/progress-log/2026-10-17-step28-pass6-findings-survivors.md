# Step 28 pass 6: distinguish the findings mutants

[Pull request #142](https://github.com/melian-agent/melian/pull/142).

Added controls for introduced and pre-existing trigger comparisons, absent hunks, identical hashes in different files, changed dismissal attribution and pruned legacy sightings.
Each kills the exact cold-round mutant for its condition. The source is restored after each run.

Sixteen exact variants ran over 74 tests: thirteen failed and three are equivalent under the stored lifecycle invariants.
The equivalents are the version-8 identity upgrade and the two redundant status comparisons.
The reasons and logs are in tmp/step28-equivalents.md; every mutation is appended to tmp/step28-phase2-mutations.md.
The already accepted publication equivalents now name cold-round lines 671 and 835.

Validation: all 74 findings and dismissal-trigger tests passed after restoration, as did type checking.
The whole gate follows the publication fix. The implementation plan stays unchanged for this fix pass.
