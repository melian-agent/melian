# Token telemetry built

[Pull request #146](https://github.com/melian-agent/melian/pull/146) builds milestone 2 step 32.

The [decision](../decisions/2026-10-18-token-telemetry.md) audits every model path and supersedes the stage telemetry decision, restating its surviving clauses. Conversation ledgers already count retries, failover, escalation and compaction. Their projection now retains every model's token kinds and cost. The LLM triage decider now commits reported response usage with its decision or failure, including a rejected answer.

Telemetry text, the review summary and JSON show totals. Unknown usage remains unavailable. Live lens, verifier and triage evals retain the same detached record and print each golden's tokens and cost beside its score. Triage measurement JSON keeps each pass's full telemetry.

No existing stored document or task version changes. Inputs, attach keys and publication fingerprints stay unchanged. A new task-keyed document family keeps triage usage outside the shared findings, verdict and publication upgrades.

Seventeen regression tests fail against the starting source, e0a9d00f5ecd4bb25a642c815f921479bb4370c1. The focused run passed all 193 tests in seven affected files; later tests prove totals, escaping and optional counters. SQLite crash probes cover both sides of the terminal commit. All 70 hand mutations fail their tests and are restored. The local report and exact inventory are under tmp/token-telemetry-report.md and tmp/token-telemetry-mutation-inventory.jsonl.

The full gate ran twice. The final run has 4,517 passing tests, four ps-dependent failures under the sandbox, and 53 skips. Lint, types, pinned dependencies, release age, tools and the audit gate pass. No timeout failed despite peak machine load of 43. No test was weakened. The coordinator must run the host gate and mutation check before the first full round.

No live model calls or model-based reviews ran, as the brief requires. The coordinator owns those reviews and the comparison record. The pull request stays a draft.

The specification commit is 204fa098, "docs: define token telemetry for every model stage". The implementation commit is "feat(pipeline): retain token use for every model stage".
