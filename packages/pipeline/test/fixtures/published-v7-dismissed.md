# Version-7 dismissal recordings

The two JSON files `published-v7-dismissed-resolved.json` and `published-v7-dismissed-pending.json`
were written through the unchanged publisher from commit 85fa394633ad0f9d317a9c88c3f8c3fd7e4e9e55.
They are producer snapshots, not constructed old shapes.
The recording test loaded that commit's publish.ts beside the current source and removed the copy afterwards.

Both start with an inline finding in src/a.ts and a body-only finding in outside.ts.
The repository changes src/a.ts from old to new; both git dates are 2026-10-18T00:00:00Z.
The first publication posts both findings. The second verdict dismisses both with the recorded reason.
The resolved recording refuses the dismissal reply after accepting the review.
The pending recording refuses the review before posting either resolution.
Both therefore leave the dismissal unjournalled. Each includes the fake provider and companion documents for replay.

The reopen test checks exact resolution keys, preserves the pending payload and reopens the upgraded document twice.
It then publishes twice and requires exactly one dismissal reply.
No real provider or model was used. Recording output: `tmp/orphan-thread-pass5-fixture-writer.log`.
