# Prove doctor’s policy commit bound

[Pull request #86](https://github.com/melian-agent/melian/pull/86)’s committed-base test now checks the exact seven-character policy commit. Shortening the display to six characters passed before the assertion and fails after it.

Removing deadline rejection also fails the stalled permission-body test when run alone. Abort alone cannot finish parsing a response body that never sends data.
