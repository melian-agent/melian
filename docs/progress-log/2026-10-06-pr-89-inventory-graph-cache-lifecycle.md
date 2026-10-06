# test(pipeline): prove graph publication recovery and cleanup

For [pull request #89](https://github.com/melian-agent/melian/pull/89), Five graph cache cases prove disappeared and denied entries, concurrent-winner recovery, reader closure and scratch cleanup. All seven uncovered mutations fail; all 14 restored graph cache tests pass.
