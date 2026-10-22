# Step 23b: isolate comparison tests’ git identity

Fix for [pull request #162](https://github.com/melian-agent/melian/pull/162). Node 22 CI failed the match, unmatch and adjudicate round-routing tests. They passed locally because the host supplied a git author.

The fixture’s commit helper supplied an identity to its own git commands. The CLI’s later git commands inherited the test process, which had no author in CI. The suite now stubs `isolatedGitEnv` in that process and restores it after each test. No production behaviour changes.

Reproduction: with author variables unset, global and system config absent, and `user.useConfigOnly=true`, the three write tests failed with “git has none” before the fix. The same command passes after the fix. Removing the environment setup reproduces those failures again. The report retains both runs.

Implementation: `b0a9b0f1`. Round-ID boundary proof and the draft links: `416e6eaf`. The host gate and Stryker remain coordinator work because the Codex seatbelt denies `ps`. No live model ran.
