# Step 11: measured Enola verdict

The spike defines per-file call pairs and imports against TypeScript 7.0.2 at branch-point commit ad303b56fac7e40b13a1a7e51140fa05a9a4b570. Enola matches 825/5,723 pairs (14.4%) and 207/407 imports (50.9%). The report lists every missing unit: 4,898 call pairs and 200 imports.

The measurement exit criterion is met. Search stays unrestricted over every file. Cold and warm cost, cache size and reuse, the layering breach, and the limits of the proof are recorded in docs/spikes/enola-coverage.md. No live model was called.

Fix pass: indexed facts by file and explicit import target, grouped transcript reads and declarations once, and counted caller-prompt bytes incrementally. Coverage attachment uses a set of changed paths. Removed internal spike TSDoc. Structural complexity in compiler traversal and transcript correlation remains; the fix report distinguishes bounded work, linear validation and the generated-document hotspot.
