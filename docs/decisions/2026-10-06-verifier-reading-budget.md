# Verifier reading budget

Supersedes: [2026-10-05-verifier-as-built.md](2026-10-05-verifier-as-built.md), choice 10’s per-candidate limits only.

Problem: GPT-6.1 Sol exhausted the verifier’s 20-call budget while checking one candidate in the fourth review round of [pull request #80](https://github.com/melian-agent/melian/pull/80).

Example: the candidate used 20 tool calls and 45,902 tokens, then ended. Its verifier check could not record ran, leaving the review not reviewed.

Choice: raise each candidate’s limits to 300,000 tokens and 60 tool calls. Keep both as constants, with at most eight conversations running together. This step adds no configuration key.

Why: GPT-6.1 Sol reads more code per claim than the original limits allowed. Larger bounded budgets give it room to finish verification.
