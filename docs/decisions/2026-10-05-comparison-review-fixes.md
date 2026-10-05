# Keeping comparison metrics and debt reachable

Choice: Imports retain reviewer identity even when empty. Pending or ambiguous reports skip their reviewer's recall denominator in that group. An explicitly judged ambiguous report still enters precision. A valid external report without a miss reason becomes pending if its match disappears, and stats counts these reports separately.

Adjudication searches every stored round newest first and writes to the round holding the ID. Replacement judgements preserve debt unless `--golden` changes it. Duplicates name another finding through `--of <id>` and cost their reviewer recall as well as precision.

Metrics filters select whole changesets by first comparison time. Candidate checks, backlog, and drain use the whole clone. Candidates cluster valid external findings Melian missed; Melian's own findings remain available through the lower-level repeat query.

Stats, backlog, and export use storage reads without a harness or durable commit. SQLite schema setup still requires writable storage. Export reaches stored rounds without a current-head review, uses six-column tables with bounded first-paragraph summaries, prints author names without emails, and omits the drain notice.

Why: A reviewer that reports nothing must still be measured. A pending report must not become an assumed miss. Debt from a finding dropped in a later review must remain reachable until the maintainer declares it discharged. A date filter must not hide that debt.

Supersedes: [2026-10-05-comparison-metrics.md](2026-10-05-comparison-metrics.md), for the refinements above. Its grouped arithmetic, changeset selection, and conservative local drain notice still apply.
