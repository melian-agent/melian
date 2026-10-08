# Step 14: validate every Biome exclusion

The follow-up closes Codex finding 5. Guardrails compile every normalised Biome exclusion, including its directory form, before matching any changed path. Tests cover a refused glob after **, a matching bare glob whose directory form is refused, the compiler boundary, and an unused base exclusion. Mutation results and the full gate are in `tmp/step14-followup-report.md`.
