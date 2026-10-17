# Prove migration of dismissed and body-only resolutions

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 5, covers the untested migration at publish.ts:154.
Two fixtures come from the unchanged version-7 publisher at 85fa394633ad0f9d317a9c88c3f8c3fd7e4e9e55.
One stores resolved work after a refused dismissal reply; the other stores a refused pending round.
Both contain a dismissed inline finding and a dismissed body-only finding.

The new test first failed under the review's exact replacement, resolutionKey(resolved) to replyKey(id, entry.thread!).
The diff showed a missing dismissal version and an extra separator on the body-only key.
Restoring the source passed both cases.
The test preserves the pending payload, commits the migration and checks another SQLite reopen.
It then publishes twice and asserts exactly one dismissal reply.
The instrumenter's empty-array mutant and skipping pending migration also fail.

No production source or document version changes. The plan stays unchanged for this fix pass.
Exact failing and passing runs and the appended inventory are in `tmp/orphan-thread-pass5-report.md`.
