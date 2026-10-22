# 2026-10-22: CLI publication fixture follows the base suffix

The whole gate on [pull request #168](https://github.com/melian-agent/melian/pull/168) found one more assertion of the old status description. The walkthrough test with writer trust disabled checked the GitHub description without its reviewed base. Its CLI-output assertion was already correct because the CLI renders the verdict's own description.

The GitHub assertion now includes the exact base suffix. The failure is recorded in the initial gate log. The walkthrough and status test files pass after the correction. The final whole gate runs after the hand mutations, with source and test files unchanged throughout.
