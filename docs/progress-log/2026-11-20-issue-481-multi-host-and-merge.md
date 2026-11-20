# [Issue #481](https://github.com/melian-agent/melian/issues/481): hosts that each hold some rounds, and the static rule the merge carried

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575).

## Hosts that each hold some of a dismissal's rounds

A property test in `review-records-export.test.ts` runs two or three hosts that share one record store and one repository. Each host keeps its own findings and holds only the rounds it ran. A seeded history opens with a review and a dismissal on host 0, takes three to seven random steps (an edit beside the finding, an edit elsewhere, a review or a dismissal, each on a random host), and ends with a review the reader reads. An oracle host runs every round and every dismissal in order, as a host that held them all would. The test fails if the reader keeps a dismissal the oracle reopened.

At the default 20 seeds, `MELIAN_PROPERTY_SEEDS`, the reader and the oracle agree on every seed: 8 keep the dismissal and 12 reopen it, in about 30 seconds. At 600 seeds they agree on every seed again: 312 keep it and 288 reopen it, in 800 seconds, with no seed where only the reader or only the oracle keeps it. The test's timeout grows with the seeds asked for, 60 seconds plus 5 per seed.

Two seeds that once found a defect stay as named cases. Seed 9 let a reader that skipped each round's own revision keep a dismissal: dismissed on host 0, reopened by an edit beside it in a round on host 1, then restored and read in a later round there. Seed 302 showed a host that dismissed again a finding it held dismissed, which records nothing for others to read; the oracle now mirrors only a dismissal its host recorded.

## The static rule the merge carried

Merging `main` brought its rule for a static finding's dismissal into this branch's export: a dismissal of a static finding is shared only when a stored request proves the run of its sighting. A planted sighting whose run a stored request proves is now recorded in the store, exported by a later round and read back as dismissed. One whose run no stored request proves is refused as `unprovenRun`, left out of the export and named on stderr as unshared.

- `packages/pipeline/src/review-records.ts`: `dismissalOf`, `dismissal`, `madeOf` and `made` take the run's `proof`, `#dismissalEnvelope` checks it, and `#dismissalFacts` carries `sighting.run`.
- `packages/pipeline/src/dismiss.ts`: reads `StaticProof` before the commit and passes it to `madeOf`.
- `packages/pipeline/src/review.ts`: `unsharedDismissals`, renamed from main's, and `dismissalOf` with the proof.
- `packages/pipeline/src/errors.ts`, and the planted-sighting, unproven-run and withheld tests.

The export seam is frozen beyond [pull request #557](https://github.com/melian-agent/melian/pull/557) and [pull request #562](https://github.com/melian-agent/melian/pull/562). This branch carried main's rule and added no proof of its own.

## Mutants

`2026-11-20-issue-481-merge-mutants.json` lists `melian mutants list 8c47a6aca...ae3656dbd --claims-in` the three files above. Of its 52 generated rows in those files, 49 are killed by a named test and 3 are equivalent, each with its reason. Six hand mutants, each dropping `proof` from one call in the chain from `dismiss.ts` and `review.ts` to `#dismissalEnvelope`, are killed by the new test of a proven static dismissal. Every run was at `ae3656dbd`.

`2026-11-20-issue-481-frontier-mutants.json` lists `melian mutants list de86ba4b5...ad499a63a`, the frontier and own-revision commits, with claims in `record-payloads.ts`, `recorded-round.ts`, `review-records.ts` and `review.ts`. `restatement.ts` also changed there, but only in a comment and in which `ReviewRecords` method one line calls, where Stryker makes no mutant, so the sampler refuses it as a claims file. Of its 161 generated rows in those files, 143 are killed by a named test and 18 are equivalent, each with its reason. The `recorded-round.ts` rows ran at `ae3656dbd`, and those the new tests kill at `4fb277dd4` and `93bdef13b`, the commits that hold them; that file's lines there match `ad499a63a`. The rest ran at `ad499a63a`. A mutant that hung its named test is killed by the timeout after its test was seen to hang alone, unmutated test passing first.

The new tests, each written for a mutant that survived the suite:

- `review-records-unproven-run.test.ts`: a dismissed static finding whose run the store proves is recorded, exported by a later round and read back as dismissed.
- `review-records.test.ts`: makes and shares no dismissal record for a finding whose state froze no dismissed sighting.
- `recorded-round.test.ts`: keeps a dismissal whose frontier names a round its writer held and this set does not; tests no round its writer held two rounds before its frontier; keeps one whose writer held the round read and a later round of another revision; counts for nothing one whose frontier names only a round this set lacks, before a round that follows none; meets a round since at the read revision from that revision's own files, with no checkout; and reopens a dismissal when such a round cites a hunk that revision lacks.

## The second merge of `main`

Merging `main` again brought [pull request #551](https://github.com/melian-agent/melian/pull/551)'s stricter record schemas. The merge's own lines in trust code are three. The dismissal payload keeps this branch's `frontier` beside main's stricter `trigger`. The dismissal check reads `frontier` with main's `at`, and runs main's stamped-time check before the frontier's order check. `review.ts` keeps `predecessors` beside main's `verificationOutcome`. Tests now stamp `at` to the millisecond, as Melian does, and a listing holding a lens record under a finding's key is built as an envelope, since main refuses such a record on parse.

The frontier check's six mutants were claimed before the merge rewrote the function around them, so each ran again at `6637ca750` against its named test, which passed unmutated and failed mutated: `2026-11-20-issue-481-second-merge-mutant-runs.json`. The merge's other mutants in those files are main's, proved by its own pull request, or this branch's, proved above on lines the merge left alone.
