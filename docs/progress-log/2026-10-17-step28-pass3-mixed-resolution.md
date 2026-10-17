# Step 28 pass 3: keep acknowledgement guidance with mixed resolutions

[Pull request #142](https://github.com/melian-agent/melian/pull/142) tests one counted acknowledgement beside a counted advisory.
Changing the publication renderer’s some predicate to every removes the dismissal guidance and fails the test.
Restoring the source passes all 27 publication tests. No production change is needed.

The exact mutation and both runs are recorded in `tmp/step28-pass3-report.md`.
