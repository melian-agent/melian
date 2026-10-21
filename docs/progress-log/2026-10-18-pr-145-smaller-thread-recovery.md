# Thread reuse retires stale resolutions

[Pull request #145](https://github.com/melian-agent/melian/pull/145) closes [issue #132](https://github.com/melian-agent/melian/issues/132).

The attacking review's smaller design replaces the proposed unconditional snapshot.
The status now precedes every marker and thread read.
Reusing a thread retires its historical resolution work in the same commit, including work recorded at this head.
Signed answers span heads. The journal and GitHub each prove an answer present.
An accepted addressed edit still owes resolution when its finding returns in a fresh thread.
Human resolution never reopens or reposts a continuously live finding; it remains in the status and review body.

The GitHub adapter reads GraphQL lazily before a thread action.
It checks a reply's author against its signed root when `/user` is unavailable.
Bounded pagination rejects partial pages, failed pages and bad cursors.
The fake uses distinct thread node IDs, validates queries and supports these failures.
No stored shape, dependency, status mapping or dismissal attestation changed.

Regression evidence, mutations, gate output and commit details are in the local `tmp/orphan-thread-phase2-report.md`.
The coordinator must run the whole gate and Stryker on the host: the Codex seatbelt denies process inspection.
No live model calls ran in this pass.

The final full gate passed 4,609 tests and skipped 53. Four existing tests failed because the seatbelt denies `ps`; there were no timeouts.
All publication regressions passed, including the SQLite kill and the hidden human-resolved thread.
The pass ran 56 manual mutation cases, with follow-up proofs for the four initial survivors and the stricter GraphQL-lag rule.
The host still owes the whole gate and Stryker. The report names every `ps` skip and failure.
