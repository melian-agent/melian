# Thinking routes: bind triage baselines to their level

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 2, addresses Codex's triage baseline finding.
Measurements now store and render the light tier's effective thinking level.
Comparison refuses different levels. Older absent levels stay unset and compare with each other.

Regression tests first showed off and high comparing as same, missing level rendering, and the live report dropping its level.
The version-2 fixture was written through the production class before the format-3 change.
Focused measurement, live-output and routing tests pass. The pass report records mutations and the full gate result.
