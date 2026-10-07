# Graph artifact symlinks

Confirmed sixth-round finding 8871cd5cd918133f for [pull request #89](https://github.com/melian-agent/melian/pull/89).
Removing O_NOFOLLOW leaves 23 existing graph-cache, coverage artifact and scratch tests passing.
Each graph artifact and entry.json now has a byte-identical symlink fixture that must read as a miss.
Restoring the regular file restores the valid cache hit, proving that content corruption did not cause the miss.

Removing O_NOFOLLOW fails all six symlink regressions; three existing graph-cache tests pass.
The restored cache, coverage artifact and scratch suites pass 29 tests.
