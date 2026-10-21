# Triage measurements distinguish thinking levels

Amends: [2026-10-19-tier-thinking-routes.md](2026-10-19-tier-thinking-routes.md), measurement identity.

A model can choose different scrutiny at different thinking levels.
Comparing off against high would attribute that difference to the questions.

The light tier's effective thinking level joins the triage measurement identity.
Measurement format 3 stores the optional level and renders it beside the model.
`TriageResults.compare` refuses different levels before judging score differences.
An absent level means unset, distinct from off. Older measurements remain comparable with each other.
The production version-2 writer supplied the fixture used to test reopening and comparison after this change.
