A dismissal now upgrades the copied adjudication checks with the same caveat helper as the task migration. An indexed input is stored JSON, so migrating its review-index document does not migrate the input inside it. A newly created task already has the current version and never runs that migration.

The regression copies the SQLite fixture written by main at `460f68f0`, relocates its policy to an identical test tree, dismisses its finding, and renders the publication body. At `a6fbc1c1`, it failed because the Reach line disappeared. With the fix, it passes. Removing the check conversion restores that failure. The targeted caveats-reopen and dismissal files pass; type checking passes. The host runs the full gate.

This fixes the first finding in the coordinator's [brief](https://github.com/melian-agent/melian/issues/212#issuecomment-6430405123) for [pull request #217](https://github.com/melian-agent/melian/pull/217). The fix pass leaves the plan and comparison record alone.
