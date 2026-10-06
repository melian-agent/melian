# Retry verification tasks that never decided

Supersedes: 2026-10-05-verifier-as-built.md, terminal-task attachment rule only.

Problem: verification attached to aborted, faulted and orphaned tasks. Those tasks supplied no reusable judgement.

Example: a cancelled task remained indexed. A later review attached to it and failed again without asking a judge.

Choice: resume live verification and reuse completed tasks only when every candidate outcome is done. Replace any other terminal task without requiring rerun. A completed attempt with recorded candidate failures remains not reviewed until rerun; a missing candidate outcome starts fresh.

Why: a task that never decided cannot supply a result. Recorded judge failures retain the retry rule and do not spend again without the caller asking.
