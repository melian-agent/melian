# Melian decision log

One file per decision that shaped Melian: what was chosen and why. [design.md](../design.md) explains each decision in full.

A new decision is a new file, so two pull requests that each record one never touch the same lines and never conflict. Never edit another decision's file. To reverse or change a decision, add a file that names the one it replaces in a `Supersedes:` line. One exception, by the maintainer's ruling of 2026-11-14: a maintainer may compact the log in a pull request of its own that does nothing else, as [the long-index decision](2026-11-14-long-decision-index-warns.md) records and [the decisions guideline](../guidelines/decisions.md#compacting-the-decision-log) describes.

Name a file `YYYY-MM-DD-<slug>.md`, dated the day the decision was made, with the slug taken from its title. The decisions made before this convention were split out of a single table on 2026-10-03 and carry that date. Each file follows this template:

```markdown
# <Decision>

Choice: <what was chosen>

Why: <the reason>

Supersedes: <file name of the decision this replaces, when there is one>
```
