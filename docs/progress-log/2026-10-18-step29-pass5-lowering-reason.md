# Step 29 pass 5: print each lowering reason once

[Pull request #144](https://github.com/melian-agent/melian/pull/144) fixes F3 from the review of record.
Terminal and GitHub output printed a lowering reason in both the ordinary line and its trust-floor note.
`Finding.lowered({ includeTrustFloor: false })` now selects only a reason the notes do not already carry.
The default query keeps its metadata. Renderers retain the header and detailed floor line, including a non-speaking member’s target.

Three tests failed first on `6a674c1e`, with four assertions covering terminal, body and ledger output.
The final targeted run passes 222 tests across six files; type checking passes too.
Nineteen generated mutations fail, including raw and resolved findings without floor notes.
A standing speaker’s distinct reason remains visible beside a protected lowering or refutation.

The final whole gate, CI head and exact mutation inventory are recorded in `tmp/step29-pass5-report.md` and `tmp/step29-mutation-inventory.md`.
No stored shape or plan status changes. No live model call was made.
