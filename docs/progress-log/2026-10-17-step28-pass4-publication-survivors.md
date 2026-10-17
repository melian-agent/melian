# Step 28 pass 4: publication mutation survivors

[Pull request 142](https://github.com/melian-agent/melian/pull/142).

A new pipeline test exercises publication through memory storage and fake GitHub.
It imports publish.ts directly, and Vitest includes it in that file's related set.
A resumed task fails its provider post; the next task must publish its pending round.
Removing the optional chain at line 1243 makes this test fail with a TypeError.

The two legacy-dismissal condition mutants are equivalent.
Pi Durable's Transaction.setTask recursively omits undefined properties before storing the task outcome.
Publication reads that committed outcome, so an absent dismissal and an undefined dismissal produce the same returned object.
Strict assertions cover current, pending and failed-task paths.

Exact mutations and dependency evidence are recorded under `tmp/step28-phase2-mutations.md` and `tmp/step28-equivalents.md`.
No production behaviour or plan status changed.

The whole sandbox gate ran: 4,516 passed, 53 skipped and four failed.
All failures require ps, which the seatbelt denies; no test timed out.
The coordinator must run the whole gate and mutation check on the host.
