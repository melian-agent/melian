# An import names a reviewer only if the login took part

Supersedes: [Keeping comparison metrics and debt reachable](2026-10-05-comparison-review-fixes.md), only its rule that an import keeps its reviewer identity when empty.

Choice: the GitHub importer records a reviewer when the login wrote a review thread or a review on the pull request. A login that wrote neither leaves the import with no reviewer. A reviewer that reviewed and reported nothing still counts, because its review is the trace.

Why: Problem: a recall denominator needs reviewers that took part. Example: a repository has no CodeRabbit. `melian compare "#7"` imports `github` by default, and the importer added `coderabbitai[bot]` anyway, so every valid defect from a Codex file counted as one CodeRabbit missed. Solution: add a reviewer only on evidence. CodeRabbit posts a review even when it finds nothing, so the review stays the proof of a quiet run.
