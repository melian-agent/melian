# Step 29 pass 5: resolve remaining sightings before lifting

[Pull request #144](https://github.com/melian-agent/melian/pull/144) closes two gaps found in the pass’s self-review.
On `6b589a2c`, a silent standing sighting of the same ID cancelled a protected lift.
A deterministic co-report could also have its count hidden. Both scenarios failed before this follow-up.

The decision now asks the existing path whether each remaining sighting and deterministic report counts.
The shared claim view keeps each sighting’s severity, judgement and check, with the merged cause and proof.
Tests cover silent, lifted, lowered, refuted and unjudged sightings, including missing historical severity.
All 29 selected guard and method mutations fail behavioural tests. A parse-only mutation run was corrected and rerun; it is not proof.
Type checking passes. The final whole gate and CI are recorded in `tmp/step29-pass5-report.md`.
No stored shape or plan status changes.
