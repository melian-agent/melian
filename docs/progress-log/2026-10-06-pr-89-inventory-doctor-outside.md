# test(cli): prove doctor handles missing repositories

For [pull request #89](https://github.com/melian-agent/melian/pull/89), Doctor now has a regression outside git. Removing the repository-discovery recovery fails; all 13 restored CLI tool tests pass.
