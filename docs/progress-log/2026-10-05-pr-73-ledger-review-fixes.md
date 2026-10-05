# Ledger review fixes

[Pull request #73](https://github.com/melian-agent/melian/pull/73) now updates the status and posts the review before ledger discovery. Discovery checks a recorded comment ID and author, ignores other publishers, and refuses damaged own ledgers with recovery instructions. The stamp authenticates the exact bounded visible body.

Summary tool objects reject unknown fields. Stored output is bounded, file paths belong to the change and prose cannot render autolinks. Summaries run only for pull requests. Fixed failure notes stay apart from successful summaries, so retries work without changing the review exit code.

Publication resolves threads whose finding markers were removed and records null without editing their comments. It caches thread discovery for one publish, keeps ledger links on abandoned statuses and prunes earlier rounds to one-line history. Base-only retargets add one round.

Regression tests cover these paths, walkthrough switches, real review run details and stored-shape migration. Validation uses the brief's Vitest, TypeScript and Biome commands; it excludes the full gate and git writes. Timings, full plan lineage and verification outcomes remain deferred.
