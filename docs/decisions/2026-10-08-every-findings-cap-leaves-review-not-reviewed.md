# Every findings cap leaves the review not reviewed

Supersedes: [2026-10-07-capped-neighbour-leaves-review-not-reviewed.md](2026-10-07-capped-neighbour-leaves-review-not-reviewed.md), only the condition requiring a rendered hand-off.

Problem: a lens can fill its own budget and leave another defect unreported. For example, correctness reports three advisories, obeys its cap and stops before a later P1. No neighbour needs to hand it that defect for coverage to be lost.

Choice: every outcome carrying `capped` records `ended`, whether a report was refused or the final count equals the findings budget. This holds when no hand-off rendered and when `budget.ended: count` accepts token or tool endings. The reason names possible handing lenses when present. Under-cap runs retain their existing completion rules.

The conservative result can require another review when exactly N defects existed. Raising the budget settles that uncertainty; counting truncated coverage as complete hides it.
