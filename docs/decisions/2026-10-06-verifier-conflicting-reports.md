# Conflicting verifier reports

Supersedes: [2026-10-05-verifier-as-built.md](2026-10-05-verifier-as-built.md), the report replacement rule only. All other choices stand.

Problem: one response may report confirmed and refuted for the same claim. Parallel execution or crash replay could leave whichever report committed last, dropping a defect the verifier upheld.

Choice: report_verdict uses Pi Durable's sequential execution mode. The durable upsert also keeps the strongest verdict for one claim within one verification task: confirmed over plausible over refuted. A weaker replacement leaves the record and findings version unchanged. The guard runs in the report's commit, including replay.

Why: ordering alone cannot protect against a later weak report or replay. A refutation must never erase a judgement that upheld the same claim.

A replacement task clears the revision’s judgements in the same commit that repoints the review index. Its first report can refute a claim the previous task confirmed. [The scope decision](2026-10-06-verifier-task-scope.md) records this correction.
