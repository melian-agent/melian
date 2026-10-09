# A republish may leave the trust answer out

Choice: a republish calls `canPublish` without stating the writer-trust answer, and an absent answer reads as trusted.

Why: a republish has no policy to consult, and refusing it would stall maintainers.

Supersedes: [2026-10-01-writer-trust.md](2026-10-01-writer-trust.md), for the republish path.
