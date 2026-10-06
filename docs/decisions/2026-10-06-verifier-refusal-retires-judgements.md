# Verifier refusal retires previous judgements

Supersedes: [2026-10-06-verifier-replaces-adjudication.md](2026-10-06-verifier-replaces-adjudication.md), extending retirement to refusal.

Problem: refusing verification left the revision’s previous verifier owner and judgements available to adjudication.

Example: a completed verification confirmed a blocker. The next review refused the verifier tier and recorded not reviewed, but the old confirmation still blocked. An earlier refutation instead hid the finding.

Choice: a policy refusal or route without credentials clears the revision’s judgements and detaches its verifier in the transaction that creates the adjudication task carrying the refusal. The task input uses the findings version after clearing. Replacing adjudication ownership in that transaction prevents its previous task from committing. The sweep aborts retired tasks before waiting for adjudication.

Why: the refusal must invalidate old proof atomically with its durable record. Adjudication sees unjudged lens findings and caps them at advisory, while the failed verifier check keeps the review not reviewed.
