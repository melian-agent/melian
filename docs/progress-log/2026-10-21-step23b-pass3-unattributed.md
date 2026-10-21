# Step 23 build 2, pass 3: address unattributed comparisons

[Pull request #162](https://github.com/melian-agent/melian/pull/162) adds `--round unattributed` to range imports, matches, unmatches and adjudications.
It selects the range revision's existing entry without inventing round identity or replacing its matches from a later verdict.
An absent entry refuses.

The genuine build-1 fixture reproduced the reported failure for finding `494eaf510dfc2491` before the fix.
The pipeline and CLI tests now pass, including SQLite reopen with the replacement judgement and its history.
Each new guard was hand-mutated; the failing runs and inventory are in the coordinator's pass-3 report.
The migration amendment records the rule implemented by version 2, including the legacy marker preserved before a first mint.
No stored shape or version changes in this pass.
