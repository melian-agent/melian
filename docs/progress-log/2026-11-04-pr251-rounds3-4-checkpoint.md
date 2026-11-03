# Record rounds 3 and 4 of the local comparison for pull request 250

For [pull request #250](https://github.com/melian-agent/melian/pull/250), append two more genuine local comparison rounds to its separate record on [pull request #251](https://github.com/melian-agent/melian/pull/251).
This is a checkpoint, not final readiness. The record is a draft, and its own host gate, CI and reviews are pending.

## What the record gains

The record [now holds](../../packages/evals/comparisons/2026-10-27-pr-250.md) 28 new rows, sections `LG` to `LK`, exported by the CLI from the stored comparison.
Round `range-3fb5345145c91fb2.r3` reviewed head `1db29aa6d7cf` and adjudicated 17 findings.
Round `range-3fb5345145c91fb2.r4` reviewed head `e4f828136e03` and adjudicated 11.
Rounds 1 and 2, at heads `737682e81f91` and `6191cd567579`, were already the sections `LA` to `LF`.
Across the four rounds the export holds 59 adjudicated rows, none pending. The 73 display rows in the record (45 earlier, 28 new) are labels, not a count of defects.

The new sections keep the export's heads, round IDs, summaries, judgements, miss reasons and goldens. Only the heading letter and the first table cell take an `L` prefix.
The decisions and Differences blocks for the two new heads are kept. Counts are omitted: the exporter counts the same finding again in each stored round, and these two rounds repeat many reports.
The existing record is a byte-identical prefix of the new file.

Round 3 had a native review of record and a Codex adversarial review. Round 4 had a Codex review only. No native review ran on `e4f828136e03`, and none is written for it.
The raw Melian run for round 3 stored its verdict and then hung, so it was ended with SIGTERM (signal 15). The raw run for round 4 exited with status 1 by itself, for its policy notices, and no signal ended it.
An extra Codex receipt for the `3379f0fc` fix had no matching Melian round. It is not a CLI comparison row, so it is neither a round nor a metric.
The cloud snapshot's native proof and durable store were never transferred, and that gap stays explicit.

## Fixes the rounds led to

These commits are on the code branch, and the record's rows stay tied to the heads that were reviewed.

- `3379f0fc` excluded binary Bun lockfiles from mutation targets, which answers `LG3` and `LH1`.
- `e4f82813` added the default-limit boundary tests, which answers `LG4`. It is also round 4's head.
- `3e7f266b` refuses enumeration results that finish after the deadline, which answers `LJ1`. No Melian or comparison round has reviewed it.

At `3e7f266b` the complete host gate passed with 7001 tests passed and 2 skipped, across 205 files, and a fresh Codex review approved.
Still pending are the complete Melian round on the final code, the final native review of record, and the record branch's own whole host gate, CI and reviews.
Nothing here says the record or the code can queue.

## One reason corrected

The Bun finding was first adjudicated `needs-execution`, because a real CLI run reproduces the refusal.
The coordinator corrected it to `owned-missed` for `LG3` and `LH1`. The defect shows when the known lockfile authority is read beside the classifier, which omits `lockb`. A reproduction confirms it and does not change how it was found.
It therefore owes a lens golden, not a tool-manifest binding.

The three findings that were found by running code stay `needs-execution`, and each now has a `repro-run` binding in `tools.yaml`: `LG1` (legacy version-1 sampling refuses inputs the historical sampler accepted), `LG2` (a backslash in a changed file name refuses the whole listing) and `LG4` (the default of 200 rows had no test at its bound).
The manifest test's expected list holds all 21 findings, and its other assertions are unchanged.

`LG1` and `LG2` remain advisories: tighten the legacy version-1 input checks, and decide how backslash file names reach canonical paths. Neither changes the version-2 schema.

## Goldens now owed

[The backlog](../../packages/evals/goldens/BACKLOG.md) gains six cases. None is written, no live eval has run, and no debt count or score changes here.
The older owed cases stay: the compatibility-output class golden for `LD5` and `LE3`, and the clean schema-currentness case for `LF4`.

- `contracts`: the Bun lockfile classifier, one case for `LG3` and `LH1`.
- `correctness`: a late success against the elapsed budget, for `LJ1`.
- `tests`: a clean case where an imported helper restores stubbed environment variables, for `LK10`.
- `design`: three clean cases. `LI1` is a coordinator handover the user asked for, which is provenance and not an injection. `LI4` is an elapsed-budget check against hard I/O preemption. `LI6` is a byte bound against a fragment-count or parent-memory assumption.

## Evidence

Every proof path is a local file, not an online report.
The CLI exports are `/Users/tal/dev/Melian/tmp/pr250-local-comparisons-through-e4f82813.md` and `.json`, under the coordinator's `tmp`.
This pass's builder, validators and logs are under `tmp/pr250-record-rounds3-4/` in the record worktree.
The pass changes no production source, schema, dependency or lockfile, and the complete production delta against the starting commit holds zero rows.
