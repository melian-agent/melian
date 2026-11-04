# Pull request export without a snapshot reads only its own store

For [pull request #256](https://github.com/melian-agent/melian/pull/256), finding `57340f7c29188781` (P2), a pull request export with no saved snapshot now reads only its own store. The parent is `414339b1f0bd754eeadfdeb107e30df6a2c6982c`.

This is a different defect from the own-history correction. That entry covers Melian finding `33830c76c2dc81b9`, which limited a snapshot history read to the pull request's own store. Melian's finding was about history only, and earns no credit here. The P2 came from a native clarification.

## The defect

A foreign store's newer comparison, rounds or publisher document blocked an own-store compatibility export. An absent own store also reported the foreign error, not the missing snapshot.

## The change

[The offline ownership decision](../decisions/2026-10-27-offline-export-stored-ownership.md) stays the authority, and the scope table in [the CLI guideline](../guidelines/cli.md#comparisons) stays as it was. No decision, schema or mechanism changed.

The export context reads the own store first. When the current snapshot is absent, it closes that store and stops. An absent own filename returns no records, opens no other store and creates no SQLite file. Refresh and bare comparison keep their default scan. Export with a snapshot still needs the whole candidate catalogue readable.

| Command | Comparisons | Candidates | Snapshot history |
| --- | --- | --- | --- |
| Stats | All stores | None | All stores |
| Backlog | All stores | None | None |
| Refresh and bare pull request comparison | All stores | All stores | Own pull store |
| Pull request export with a snapshot | All stores | All stores | Own pull store |
| Pull request export without a snapshot | Own pull store | Own pull store | Own pull store |

This closes the version-refusal class the review observed, under the existing scope. A snapshot export that meets an unreadable store in the catalogue still refuses. That is required and accepted as a P3. It does not narrow the catalogue on speculation.

## Failing before, passing after

The regressions use real SQLite stores and scripted GitHub recordings, with no network or provider.

- On the unchanged parent, the correctly configured run had 14 passes and five intended failures. Each failure reported a foreign unsupported document, or a foreign comparison where the missing-snapshot message belonged. An earlier fixture setup error is kept in `setup-error.*`. It supplies no defect evidence.
- After the fix, the final regression selection was rerun against the exact parent source and failed five tests. With the fix, all 81 tests in the four focused suites passed.
- The synthetic newer-version documents use current production document definitions with the version bumped. They are not fixtures from a live GitHub run or a future build.

The tests cover exact own JSON, raw revision scope, earlier foreign pull filenames, absent own storage, strict own documents, refresh refusal before membership writes, snapshot member and foreign catalogue refusal, and default and export argument forwarding. Two catalogue tests put a supported foreign store before the unsupported one, to prove the scan goes past the second store.

## Mutation proof

Enumeration ran through scratch snapshot `faeea5c26bad7281dd719417297a43ad510fc80e`. It holds all six source, test and guideline files and leaves out this entry. It listed 32 rows, none omitted or left unmutated: 30 generated mutants and two configuration-ignored notes. All 30 generated mutants failed their named tests, and none was equivalent. Seven supplemental variants also failed. No sample or earlier ledger was used.

The builder's run used Node 25.8.1 and npm 11.12.1, because a shell reset the intended path. That result is kept as it ran, in `tmp/pr256-no-snapshot-fix/`.

The coordinator then replayed all 30 and all seven on Node 24.18.0. It exited 0 and killed every mutant, in 52.25 seconds, and restored the files exactly. npm 11.16.0 was present, and the mutation runner does not call npm. That result is in `tmp/pr256-no-snapshot-host-proof/`. Neither run is relabelled as the other.

## Whole gate

The coordinator ran `npm run check` on the host. It exited 0 with 7,192 passed and 2 skipped across 222 files. It took 648.64 seconds wall, 636.42 seconds in Vitest, on Node 24.18.0, npm 11.19.0 and `maxWorkers` 4. The receipt is `tmp/pr256-no-snapshot-fix/host-check-exit.json`, and all seven bound files were unchanged during the run.

The gate ran on snapshot `fc6e296e93462c18bdbc150a433b5e09e22a8c7e`. It holds all seven files, including a draft of this entry, and its enumeration equals the builder's 32 rows. This rewrite follows the gate and records its results. The gate did not run on this prose, and the snapshot does not contain it. The gate is not a run of a committed head.

The builder's Node 25 sandbox run of the wider comparison suite had one failure: `passes the repository, pull request and author to the thread importer` could not find its scripted review. The same test failed with the exact parent source restored. That limits the sandbox run. The host gate passes. This entry does not say whether Node 25 or the sandbox caused it.

## What the proof binds

- Parent: `414339b1f0bd754eeadfdeb107e30df6a2c6982c`.
- `packages/cli/src/comparison-stores.ts`: `bbccb8f0b88009c7770fa986e148236947592c564c4ed9eb1c3aab50cfd1b3c9`.
- `packages/cli/src/pull-request-comparison.ts`: `38957adb70292d84dfe1333aad276986b1b1300d84352931b177ffa8935bb12f`.
- `packages/cli/src/compare.ts`: `d44fe0a015f4ab16902b0d8b0deed7d69a301ebba895c9a7bea48d29caf961da`.
- `packages/cli/test/pull-request-export-scope.test.ts`: `f4f0c2ca19a8f772657671cce56caeac4c88eb11f42f9d11142480f7aa4085f2`.
- `packages/cli/test/pull-request-comparison-unit.test.ts`: `810b4ad3ebb93ee8e681fa85355fcdbc5d865a0a3bb22519b0bbeddccff608e9`.
- `docs/guidelines/cli.md`: `b8358b64bec6bb46fdad759a54ac37e4668c5cbe8dfd3fb640041a9f4ea43631`.

Read each store a command needs, and no more. Keep the refusal for the stores it does read.

## What this does not cover

It claims no proof against a live GitHub run or a future build, and no full schema or legacy-fixture validation. It changes no decision or plan status. Fresh final-head reviews and CI on the pushed head are still to do.
