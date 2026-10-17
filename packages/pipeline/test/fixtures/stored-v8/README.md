# Recorded version-8 findings

`findings.json` was written by main at `e0a9d00f5ecd4bb25a642c815f921479bb4370c1`, through its own findings document and lifecycle functions.
`write.ts` records A, then B with different trigger content, then dismisses B.
The fixture has no accepted-trigger field.

The recording ran from that commit’s archived package sources, with workspace imports resolving to those sources and external dependencies from the lockfile install.
No source file from this branch supplied the findings document.
The sandbox refused a new worktree’s administrative directory, so the archive avoided a second checkout.

The SQLite test preserves the old behaviour on returning to A, reopens on a newer changed trigger, records a new dismissal, then proves that dismissal survives another reopen and rejects B’s content.
