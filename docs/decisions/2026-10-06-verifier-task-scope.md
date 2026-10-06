# Verifier judgements belong to one task

Supersedes: [2026-10-06-verifier-conflicting-reports.md](2026-10-06-verifier-conflicting-reports.md), the lifetime of the strength rule only.

Problem: a failed verifier can confirm a claim before it fails. A rerun that refutes that claim could not replace the earlier confirmation.

Choice: the strength rule applies within one verification task. Creating a replacement clears the revision’s judgements in the same commit that repoints the index. The new task must judge every claim again. Within that task, confirmed outranks plausible, which outranks refuted, including crash replay.

Why: a judgement must not outlive the task whose replacement promises a fresh attempt.
