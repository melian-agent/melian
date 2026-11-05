# Keep one identity after importing a legacy round comparison

Fix pass 2 for [issue #233](https://github.com/melian-agent/melian/issues/233#issuecomment-6429389271) and [pull request #215](https://github.com/melian-agent/melian/pull/215), starting at `40d8da82783e3f74900433f614b2ddd9b73d33d4`.

`fix(pipeline): keep attributed legacy rounds unique` makes the detached reader check an attributed comparison's round ID before synthesising legacy keys. A comparison attached to an existing round cannot invent another identity from its incomplete base and head. Comparisons without a stored round still supply an undecided legacy round. No stored shape or design decision changes; no plan status changes.

The regression reopens the genuine head-only stores from main and the version-1 round writer, preserves their round, imports through `CompareHarness.importFindings`, closes and reopens. It asserts the complete list contains one round, retaining the original head-only key, round ID and verdict. The setup removes only the old review-index entry: its adjudication input predates `findingsVersion`, so the current-version guard otherwise refuses the import before reaching this defect. The fixture's stored verdict stays intact.

Both cases failed on the starting production code: the reader returned the original `H` round and a second, undecided `..H` round. The passing run covers 134 tests in `round-legacy-key.test.ts`, `rounds.test.ts`, `comparison-rounds.test.ts` and `compare.test.ts`. Reproduction and passing output live in `tmp/delta-fix-pass/before.log` and `after.log`.

The complete enumeration-first inventory has eight mutants and none omitted. `tmp/delta-fix-pass/run-mutants.py` applied every mutant separately and ran its named targeted test. All eight failed assertions or raised the expected runtime error; none depends on a timeout. Three claims use the strengthened regression; five use existing tests. The inventory retains every identity field, classification, command and result in `tmp/delta-fix-pass/mutants.json`, with a log per mutant. Enumeration used an unreferenced source snapshot before committing; the final starting-head-to-HEAD enumeration is checked against that inventory before pushing.

Type checking, targeted Biome checks and `git diff --check` pass. The final unmutated reopen regression also passes both cases.

Only targeted test files run in the sandbox, as the builder instruction requires. The host must run `npx vitest --run packages/pipeline` requested by the brief and the full `npm run check` gate. Preserve the scratch inventory and logs before removing this worktree.
