# Give revision-only import safety its own block

[Pull request #85](https://github.com/melian-agent/melian/pull/85), fourteenth round, advisory 0846e84424996563. A revision-only assertion ran twice in the shared source suite, once under a worktree label.

The case now has its own revision-source block. Its setup and assertions stay unchanged. It still proves that revision imports use committed ignore rules and never read untracked checkout content. The shared source suite keeps only cases that use its selected source. No production behaviour or design decision changes.

The targeted case passes once. The full gate passes 63 test files: 1684 tests passed and 50 skipped. No test or registry timeout occurred.
