# Explicit verifier routes fail without credentials

Supersedes: [2026-10-05-verifier-as-built.md](2026-10-05-verifier-as-built.md), choice 8’s fallback condition only.

Problem: a preference file can explicitly choose an uncredentialed verifier model. The plan silently substituted a lens route.

Choice: fall back to lens tiers only when the verifier tier is unrouted. An uncredentialed explicit route fails the verifier check with the plan’s reason and lineage, as a refused tier does. Doctor warns. The resolver may still derive a credentialed route under committed policy before this check.

Why: a review must honour the explicit route it resolved, including its failure.
