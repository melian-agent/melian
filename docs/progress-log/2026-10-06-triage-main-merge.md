# Main merged into triage

[Pull request #62](https://github.com/melian-agent/melian/pull/62) now includes the named bearer credentials from [pull request #79](https://github.com/melian-agent/melian/pull/79).

The merge keeps triage's level-aware plan and credential unlock before storage opens. The credential store still selects usable named values in order, adapts OAuth-only bearers, bounds expiry, and refuses an expired command bearer before a review starts. The fake-model helper keeps both OAuth support and its uncredentialed-provider fixture. CLI tests keep both triage coverage and the expired-command regression.

The implementation plan keeps step 4's bearer status and step 5's completed triage status. The CLI guideline keeps both doctor refusal rules. The learnings retain both the published-package installation rule and the warning about document versions across worktrees.
