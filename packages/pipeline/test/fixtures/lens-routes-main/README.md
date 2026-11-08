# Verdicts, rounds and adjudication before lens routes

Recorded by main at `33138ec`, before step 37 changed any source, with `capture.mjs` copied to that tree's root and run with Node 22 and `--conditions=@melian-agent/source`, from a `git archive 33138ec` with its own `npm ci --ignore-scripts`. Main's real `ReviewPlan`, `adjudicationInput`, `AdjudicationTask`, `RoundWriter` and `VerdictDocument` wrote the store, on a fake model only. No stored shape was assembled by hand.

The plan routes `heavy` at `thinking: high` and runs the built-in `correctness` lens, so its provenance holds a plan with no `lensRoutes`. `lens-routes-v13.sqlite` is the closed store, holding the verdict document at version 13 and the rounds document at version 3. `recorded.json` holds main's adjudication task as `Harness.getTask` read it, with the initial checkpoint main's definition gives, and main's snapshots of both documents.

The reopen tests copy the SQLite file into a temporary directory, read both documents unchanged through the current definitions, write them, and reopen again. They create the recorded task input through a version-6 token and resume it under the current registry.
