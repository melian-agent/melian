# Every findings cap leaves the review not reviewed

Supersedes: [2026-10-07-capped-neighbour-leaves-review-not-reviewed.md](2026-10-07-capped-neighbour-leaves-review-not-reviewed.md), only the condition requiring a rendered hand-off.

Problem: a lens can fill its own budget and leave another defect unreported. For example, correctness reports three advisories, obeys its cap and stops before a later P1. No neighbour needs to hand it that defect for coverage to be lost.

Choice: every outcome carrying `capped` records `ended`, whether a report was refused or the final count equals the findings budget. This holds when no hand-off rendered and when `budget.ended: count` accepts token or tool endings. The reason names possible handing lenses when present. Under-cap runs retain their existing completion rules.

## What it gives up

A quick lens with a findings budget of 3 records not reviewed even when exactly three defects existed and it finished its review. The maintainer must raise the budget and rerun to settle that uncertainty. When one of those defects blocks, the CLI exits 2 for not reviewed instead of 1 for blocking findings; the findings still print.

A softer rule would count a lens as capped only when a report was refused or the lens explicitly said it stopped early. That would spare complete runs with exactly N defects. It would also trust the lens to report its early stop, although a lens told its cap can stop at N without asking to report another defect. The default stays conservative.
