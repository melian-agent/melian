# Publication binds a proven round

This refines publication migration in [the rounds decision](2026-10-18-compare-rounds-exact-rule.md).
It follows the maintainer's ruling on [pull request #152](https://github.com/melian-agent/melian/pull/152).

An old publish task can name a revision without naming its round.
For example, build 1 could create a task after r2, then decide r3 before the task resumed.
Assigning the legacy ID would publish r3 through the mutable live verdict.

An unbound target or pending task written before version 6 binds to its revision's legacy round only when no minted round exists there.
The migration reads `melian.rounds` in the transaction that binds the target.
When a minted round exists at that revision, the task ends superseded and posts nothing.
Its reason says the round cannot be proven and asks for a fresh `melian publish`.
Minted rounds at other revisions do not prevent migration.

Every publish task reads its bound round's verdict copy, including a legacy round.

A fresh publication captures the current round ID with its live verdict, provenance and completed decision in one transaction.
Permission reads can take long enough for another review to decide a later round.
Before recording a target, that transaction requires the current round to retain the captured ID and saved verdict.
Otherwise publication refuses, records no target and asks the maintainer to publish again.
