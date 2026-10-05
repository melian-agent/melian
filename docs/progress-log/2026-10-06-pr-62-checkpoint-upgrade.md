# Mid-review checkpoint upgrade coverage

[Pull request #62](https://github.com/melian-agent/melian/pull/62) now tests the registered lens task's version-1 migration with a checkpoint past spawn. The review checkpoint holds one child and failover attempt 1 on a two-model route. The test asserts that migration preserves the phase, child ID and attempt, while upgrading the input and keeping the legacy producer version. The SQLite resume test still covers a version-1 task at spawn. Neither test calls a real provider.
