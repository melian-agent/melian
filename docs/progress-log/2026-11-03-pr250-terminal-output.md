# Compatibility mutant output escapes terminal controls

For [pull request 250](https://github.com/melian-agent/melian/pull/250) and [issue 239](https://github.com/melian-agent/melian/issues/239).

The compatibility script now escapes every variable table cell, ordinary JSON and complete error message with core’s `visibleText`. Child stderr is piped into the catch. Legacy JSON values and structural delimiters stay intact.

Regressions reproduced raw controls in table, JSON, bad-range, missing-sample and child-stderr routes at `6191cd5`. Synthetic cells and injected child output cover all 79 controls. Actual argv covers 78 because it cannot contain NUL.

Focused validation and the complete fix-only mutation inventory are recorded under `tmp/pr250-approved-phase-a/`. The coordinator owns the pending full host gate. No model calls or Melian reviews ran.

Validation: 26 compatibility tests and 800 existing core, CLI and sampling tests passed. Focused Biome and `npm run typecheck` passed. The fix-only inventory has 14 rows, omitted zero: 12 assertion kills and two equivalence probes, including seven explicitly labelled policy exclusions applied by hand. Eight supplemental removal probes failed assertions. Source bytes were restored and their SHA-256 checked after each generated probe.
