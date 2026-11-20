# A valid miss keeps the conversations behind it

[Issue #559](https://github.com/melian-agent/melian/issues/559), item 3. When `melian compare adjudicate` judges an external finding a valid miss, Melian copies the round's conversations that could have caught it into the clone's evidence directory, and `melian compare evidence` prints them. [The decision](../decisions/2026-11-20-miss-evidence-is-kept.md) sets out the rules and amends store retention.

- 28ec6654e adds `evidence.budget`, 1 GiB by default, read only from the root `melian.yaml` or the user's preferences.
- 2aa63cef6 adds `EvidenceStore` and `MissEvidence` in the pipeline, `CloneEvidence` in the CLI, the copy on a valid miss and `melian compare evidence`.
- ba0d974bf adds doctor's `evidence` line and makes `melian store prune` keep `evidence/` and count its bytes.
- d79f365a6 moves the choice of stages to `MissEvidence.stagesAt` and the ownership check into `CompareHarness.evidence`. A round counts as the run's owner only when the review index's adjudication task is one of the round's tasks.
- aabaf0c01 adds the tests the mutation run asked for, and takes the base and head from the round.
- 9812df9b7 records the code hashes the work changed.
- 355d8985c keeps a miss's evidence out of the adjudication's code hash. `compare.ts` no longer imports `MissEvidence`: `CompareHarness.ownedRun` returns the owned round, its verdict and the storage, and the CLI's `CloneEvidence` calls `MissEvidence.gather`. A test in `scripts/code-hashes.test.mjs` asserts that the adjudication producer reaches neither `evidence.ts` nor `telemetry.ts`; it failed with `expected [ …(117) ] to not include 'packages/pipeline/src/evidence.ts'` and then passed. Against 9812df9b7 the adjudication producer's list lost `decisions.ts`, `evidence.ts` and `telemetry.ts`. Against the base no producer's list changed, and only the hashes of `config.ts`, for `evidence.budget`, and `compare.ts` moved.
- 94f5da0b6 makes the budget's refusal name `<state>/evidence/<changeset>/`, say that prune keeps it, and say to raise `evidence.budget` until the prune lands in [issue #627](https://github.com/melian-agent/melian/issues/627). It no longer tells anyone to remove evidence by hand. Doctor's warning, the help text, the guidelines and the decision say the same. The two refusal tests and the doctor test failed on the old wording and then passed. No producer's list changed, since `evidence.ts` is in no producer's reach.

## Not built

`melian store prune --apply` does not remove evidence 90 days after a merge. No code reads a pull request's merge time, and the retention decision requires its plan-to-removal races closed before prune removes anything durable. The coordinator deferred it to [issue #627](https://github.com/melian-agent/melian/issues/627) on 2026-11-20, as an answer on approach.

## Tests first

Each rule added after its code started from a failing test:

- The budget's config tests failed 4 of 267, with `expected undefined to deeply equal { budget: 1073741824 }`, and passed 267 of 267.
- Doctor's test failed 1 of 6 and then passed.
- The prune tests failed 2 of 76, with `expected StorePrune{ …(5) } to match object`, and passed 76 of 76.
- The CLI store tests failed 3 of 20 and then passed 48 of 48 across three files.

The store, gather and CLI rules were written before their tests. The mutation runs below stand in for their failing runs: the first run at 2aa63cef6 left 99 survivors, and each new test was written to kill one, then confirmed against that mutant.

## Mutation inventory

[The inventory](2026-11-20-issue-559-evidence-mutants.json) is version 2, from `melian mutants list c2e68c4e7...HEAD --claims-in packages/pipeline/src/evidence.ts --claims-in packages/pipeline/src/store-prune.ts --claims-in packages/pipeline/src/compare.ts --json --all` at 94f5da0b6. It lists 646 mutants. The three claimed files hold 331 generated. Of the 331, 321 are `killed` and 10 are `equivalent`, each with its reason. The first inventory, at aabaf0c01, held 335 claims, 325 killed; the move to `ownedRun` changed `compare.ts`'s mutants.

Each kill ran by hand against its named test alone. The test was matched by its anchored title, collected exactly once, and passed unmutated first. After the move, `npx vitest list --filesOnly --changed 9812df9b7` listed both evidence test files and both compare-evidence test files, which name almost every claim, and `compare.ts` and `evidence.ts` changed, so every one of the 331 claims ran again at 94f5da0b6. The 10 survivors are the 10 equivalents the first run found, `compare.ts`'s `verdict !== undefined` now at line 206. [The runs](2026-11-20-issue-559-evidence-mutant-runs.json) record each result. The worktree's source was clean after every run.

`packages/cli` files are outside the claims. The CLI tests in `packages/cli/test/compare-evidence.test.ts` cover them.

Timing: mutants 4 × 130 min (the average of four runs); other 1 × 30 min (unit and CLI test runs); gate 3 × 15 min.

- Finding lens.tests P2 on evidence.ts:95-117 (untested `lensFiles`): `packages/cli/test/compare-evidence.test.ts` "records the blob of a repository lens at the policy commit, and no other lens" adjudicates a miss under a `revision:` policy with a committed lens. Mutants run by hand, each failing the test alone: deleting `files.push(...)` and removing the `!` from `!named.has(...)`.

## Review of record fixes

- 70bf64450 makes `melian compare evidence` print a lens's system prompt. A lens's `pi.system` entry leaves `content` empty and holds the brief and the injection policy in `sections`, so the text view printed an empty `system:` for every stage. It now prints each section, and the tools the entry adds or removes, through visible text. The extended test in `packages/cli/test/compare-evidence.test.ts`, "keeps each covering lens run once for two misses, and prints them visibly from a later process", failed at 9b42e9d9a with `expected 'Evidence for … in roun…' to contain '  system:\n    <injection_policy>\n  …'`, and then passed.
- 2874dacab keeps a lens's instructions when the 16 MiB stage bound cuts a conversation. The bound kept the first entry and the tail, so `pi.system`, the second entry, went first. It now keeps every entry before the first reply, then as many of the last as fit; leading entries that alone pass the bound keep as many from the first as fit, so the bound holds. Three bound tests in `packages/pipeline/test/evidence.test.ts` failed at 70bf64450, each because the system entry or a leading entry was dropped, and then passed with the rest of the file, 55 of 55.

[The R2 inventory](2026-11-20-issue-559-evidence-r2-mutants.json) is version 2, from `melian mutants list 70bf64450...HEAD --claims-in packages/pipeline/src/evidence.ts --json --all` at 2874dacab. It lists 49 mutants, 43 in `evidence.ts`: 39 `killed` and 4 `equivalent`, the loop guards at 0, each with its reason. Every kill ran by hand at 2874dacab against its named test alone, collected once and passing unmutated first; all 39 failed, `head++` by its 90-second timeout. [The runs](2026-11-20-issue-559-evidence-r2-mutant-runs.json) record each result. The source was clean after every run. The six `packages/cli/src/evidence.ts` rows are outside the claims.

The second round, on b81227a54, found that no test adjudicated an unmatched external finding as noise. "keeps nothing for an unmatched external finding judged noise" in `packages/cli/test/compare-evidence.test.ts` passed unmutated. With `fields.verdict === "valid" &&` in `packages/cli/src/compare.ts` replaced by `true &&`, it failed with `expected 'Adjudicated … as noise…' not to contain 'evidence'`.

A reading pass over the mutants of the CLI, config and doctor changes added three tests. `compare-evidence.test.ts` "keeps nothing for a miss judged a duplicate of another" kills `fields.verdict === "valid"` widened to `!== "noise"` in `compare.ts`. Its "records no lens file for a valid miss with no file, though the policy is a committed revision" kills `commit === undefined || file === undefined` becoming `&&` in `CloneEvidence.lensFiles`. `doctor.test.ts` "warns outside a repository without reading GitHub" now also asserts no `evidence` line, killing the removal of the `root === undefined` return in `evidenceCheck`. Each was seen to fail with its one mutant applied by hand.
