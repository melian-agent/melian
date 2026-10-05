# Ledger implementation pending publication

The `review-ledger` working tree implements one signed ledger comment across heads, bounded walkthrough and run-detail sections, collapsed history, addressed comment edits with thread resolution, and the agent prompt in `melian findings`.

The brief’s dismissal decision dated 5 October is absent; the implementation follows [the 4 October decision](../decisions/2026-10-04-dismissal-publication.md). The named pipeline publication file and summarise task were absent too. Publication records live in `packages/pipeline/src/publish.ts`, and this step adds the summary task.

This entry awaits its pull request number. Git cannot write this worktree’s metadata under the shared git directory, and the sandbox cannot reach GitHub. The implementation plan therefore keeps step 8 open until the gate, commit and draft pull request are recorded.

Biome, pinned dependencies, type checking and the full Vitest suite pass. The gate cannot verify release ages or audit dependencies because registry DNS is blocked. Tests cover signed stamps, one comment across heads, walkthrough switches, escaped sections, bounded bodies, addressed edits, thread-resolution recovery on a later head, SQLite migration and SIGKILL after a ledger edit. The CLI test that timed out under load passed when run alone.
