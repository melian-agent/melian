# Step 23 build 2, pass 3: export stored round order

[Pull request #162](https://github.com/melian-agent/melian/pull/162) exports r1 before r2 even when r2 was compared first.
The comparison reader orders entries by the stored rounds, and the exporter preserves that order in markdown and JSON.

The reproduction imported r2 before r1 and failed on the reversed reader order before the fix.
Three exporter assertions also failed on comparison-time ordering.
All 57 pipeline and exporter tests pass after the change.
Hand mutations of the ordering predicates and arithmetic, and restoration of comparison-time sorting, fail the order tests.
The pass-3 report holds both runs and the mutation logs.
