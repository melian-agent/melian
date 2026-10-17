# Recorded version-9 findings

`findings.json` was recorded by main’s code at `748dfe37f634550f9aba8b8886aefa4e09984dab`.
The recorder uses that commit’s `FindingsDocument`, `upsertFinding`, `upsertVerification` and `dismissFinding`.
It records two trust-boundary P2 claims lowered to P3, one introduced and one affected, then dismisses them.
Each dismissal accepts its trigger; the affected dismissal also accepts its proof hash.

`write.ts` is the recorder. Run it against that commit’s source, using the fake model and memory storage.
No model request runs. No stored shape is written by hand.
The recording used archived sources for core, pipeline and decisions, with workspace imports redirected to that archive.
External imports resolved from the unchanged lockfile installation.

The SQLite reopen test writes the snapshot through a version-9 token, closes storage, and reads it through version 10.
It preserves the complete snapshot and verification, writes an unchanged sighting, and reopens again.
A changed trigger reopens the introduced dismissal. Changed proof alone reopens the affected dismissal.
Both findings then retain their trust floor and fail the published status mapping.
