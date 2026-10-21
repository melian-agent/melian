# Builder probes cover survivor classes and reproduce their selection

[Pull request #165](https://github.com/melian-agent/melian/pull/165), pass 2, Codex finding 3.

The checklist now names eight survivor classes. Builders annotate each inventory row with its coverage claim, evidence and classes. `--sample <inventory.json>` includes every new-test and equivalence claim, covers each represented class, mutator and file, then selects a fifth of each file’s remaining kill claims by deterministic hash, rounded up. The output includes the hash and preserves rejected entries. Incomplete inventories and missing annotations fail.

The CLI test first failed because --sample was unknown. Against a selection stub, 37 unit tests failed on missing hashing, selection, rounding, validation and checklist labels; six passed. The implemented selector passes all 43 unit tests. The script suites pass 66 tests. Tests compare exact selections, reverse input order, exercise all eight classes, cover rare files and mutators, and check the rounding boundary and one past it.

Mutant identity now includes both start and end coordinates. Stryker emits whole-condition and operand mutants at the same start. Sampling and hand probes must distinguish their spans. The pass report records the complete inventory, each mutation probe and final validation. No model calls ran. The implementation plan stays unchanged for this fix pass.

All 117 sampling replacements ran: 116 failed named tests. The configured StringLiteral exclusion for the UTF-8 encoding is equivalent when replaced with an empty encoding: readFileSync returns a Buffer and JSON.parse coerces it to the same UTF-8 string. The full pass inventory lists 172 mutants with none omitted. The report records the sampler’s selection from that complete classified inventory. Earlier fixes in this pass are `d3662bd8` (trust wording) and `8a4b67f7` (head entry kinds).
