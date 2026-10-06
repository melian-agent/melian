# Verification replacement retires adjudication

Supersedes: [2026-10-06-verifier-task-scope.md](2026-10-06-verifier-task-scope.md), the replacement transaction only.

Problem: a failed verification can leave an adjudication parked before its verdict commit. A rerun replaces verification but retained that adjudication’s ownership.

Example: the old adjudication records not reviewed while the new verifier judges the same claims, overwriting the replacement review’s result.

Choice: the transaction that replaces verification clears previous judgements and removes the revision’s adjudication entry. The existing sweep aborts that adjudication before waiting for verification. Its terminal commit refuses ownership the index no longer names.

Why: removing ownership atomically prevents a stale verdict even if the process dies before the sweep aborts the old task.
