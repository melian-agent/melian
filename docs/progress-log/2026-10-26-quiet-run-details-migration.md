# Preserve version-9 publication resolutions

Fix pass for [issue #213](https://github.com/melian-agent/melian/issues/213) and [pull request #221](https://github.com/melian-agent/melian/pull/221).

The version-10 migration now leaves version-9 records unchanged.
Earlier versions still upgrade their finding-keyed resolutions.
Main’s `460f68f0` publication code recorded pending, unanswered and answered fixtures.
All three SQLite reopen cases failed before the fix: a resolution key gained a second thread suffix and its finding ID became the composite key.
The same cases pass after the fix, preserving the whole document and receipts across another reopen.
Targeted migration tests cover versions 1–4 and 6–9. The host runs the full gate.

Mutation proof: all four enumerated mutants were applied individually and killed by the version-8 or version-9 reopen file. None were omitted. The [complete inventory](2026-10-26-quiet-run-details-migration-mutants.json) records each run.
