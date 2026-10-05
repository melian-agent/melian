The thirteenth review of [pull request #62](https://github.com/melian-agent/melian/pull/62) found no test pinning an escalation's restatement to the finding's file. The matcher already checked the path.

The new regression reports the same rule on overlapping lines in two files. The quick finding remains counted under its own producer beside the careful finding in the other file. Removing the path comparison fails the test by dropping the quick finding. The original matcher is unchanged.
