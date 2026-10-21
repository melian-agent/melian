# Thinking routes: protect committed levels

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 2, addresses Codex's local override finding.
The model-override guard now refuses changed thinking under `acceptOverridden: false`, including a lens moved to another tier.
Accepted overrides carry the effective level, committed level and source through check lineage and rendering.
Thinking-only preferences retain model derivation.

Regression tests failed first: protected policy returned `routed`; accepted changes had no lineage.
The rendering test also failed before the fix. Focused plan, render and SQLite reopen tests pass.
The pass report records mutation proofs and the full gate result.
