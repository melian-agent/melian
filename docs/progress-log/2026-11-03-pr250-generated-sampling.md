# Version-2 sampling keeps ignored rows as notes

For [pull request 250](https://github.com/melian-agent/melian/pull/250) and [issue 239](https://github.com/melian-agent/melian/issues/239).

Only generated rows enter version-2 classification and sampling quotas. Full ignored config and comment rows remain owned notes, with optional valid claims preserved. The raw schema and version are unchanged. Version 1 retains its historical output and selection.

Eight regressions failed before the source fix: unclassified ignored rows were refused, classified ignored rows entered quotas, and empty ignored groups were absent. Tests cover generated-only quota boundaries at five and six remaining rows, mandatory groups, invalid supplied metadata, ownership, legacy labels and both CLI routes.

Evidence, exact mutation runs and focused validation are recorded under `tmp/pr250-approved-phase-a/`. The full host gate remains coordinator-owned.

Validation: all 861 focused core, CLI and compatibility tests passed. Focused Biome and `npm run typecheck` passed. The complete fix-only inventory has 27 rows, omitted zero. Every row failed its exact named test by assertion, including three explicitly labelled policy exclusions applied by hand. Six supplemental probes failed assertions, covering the five/six boundaries, note ownership and both uses of generated-only classification. Source bytes were restored in `finally` and SHA-256 checked.
