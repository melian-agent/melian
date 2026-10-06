# Keep each lens's standards paths inert in the ledger

[Pull request #85](https://github.com/melian-agent/melian/pull/85), twelfth round, finding 32f8f4d5ba44247f. The per-lens standards test used plain paths. Bypassing code with single-backtick wrapping passed all 50 existing ledger tests.

The same test now includes a standards path containing a backtick, Markdown link, newline and Unicode separator. It requires a code span whose fence exceeds the path's backtick run and visible escapes for both line breaks. Assertions inspect the run details, apart from the hidden stamp and overall union.

All 50 ledger tests pass. The original mutation fails the strengthened test on its escaped per-lens standards assertion. The renderer was restored after the probe and has no production change. No design decision changes.
