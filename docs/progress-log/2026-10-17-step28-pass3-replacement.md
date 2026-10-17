# Step 28 pass 3: reopen replaced policy notices

[Pull request #142](https://github.com/melian-agent/melian/pull/142) keeps the old check sighting until dismissal reopening is decided.
Check replacement then removes stale versions and absent reports, preserving other producers.

The preceding-build SQLite test failed first: replacement left the notice dismissed instead of new.
It now passes and publishes failure for the reopened notice alone.
Replacement tests also prove current and other producers survive while obsolete versions disappear.
Hand mutations of the ordering and each retention condition fail those tests.
The whole gate result is recorded in the pass report under `tmp/step28-pass3-report.md`.
