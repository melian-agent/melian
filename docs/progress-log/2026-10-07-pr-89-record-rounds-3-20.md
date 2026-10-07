# Comparison record for [pull request #89](https://github.com/melian-agent/melian/pull/89), rounds three to twenty

The record now covers twenty Melian rounds, the second fix pass, and the final adjudication of Claude's fifteen items. Round twenty-one on `74a45a5` is running and is not recorded. The record names no fix commits, so this entry holds them.

Counts: 64 defects above advisory across twenty rounds, 63 valid. The pass for round fifteen refuted one as designed behaviour. Rounds one and two found 18, and rounds three to twenty found 46.

The record corrects three cross-references the first version had wrong. B4's stored-shape drift is Claude's C11, not C9. B14's mutation survivor is C3, not C1. A2 duplicates C12, not C10.

## Fix commits by pass

First pass, to `78354c3`:

- `972c632` legacy transcript coverage
- `f3e80d7` pinned-archive authentication
- `8931062` tool pins in published installs
- `6c91884` import coverage by source
- `409808f` base policy for both Enola runs
- `9aa4b0c` Enola sourcing text
- `2397c21` and `25d4b67` cleanup after worktree errors
- `e048eef` cache publication
- `bec7ae0` unsafe archive paths
- `7f1cc94` immutable coverage evidence
- `7a6e16e` doctor isolation
- `1b41ea8` coverage for attempted lenses only
- `78354c3` repeated scans

Second pass, `fix89b-report.md`, merge `40cb30c3`:

- `19038977` getter-returned functions
- `c820fe7d` test-file call evidence
- `c20f5476` hidden tar-name bytes
- `09eb3ad0` one repository for Enola
- `897616a0` release-bound downloads
- `eeaf37e5` offline-tolerant release metadata
- `821662fe` graph entries replaced by files
- `d44f5607` shared state-directory rule
- `d59bc543` visible error control characters
- `6e440719` and `7c9ce2b2` caller context in the lens key
- `8d2a1b83` typed snapshot and coverage evidence
- `0b9a67a0` transcript history pages
- `8643e867` configured quarantine window
- `81c93d74` pinned base for Enola
- `6eceb3eb` empty exit-one reports
- `986de1d4` CLI caller proof
- `abaa0b2f` scratch sweep after crashes
- `112a2267` import matching

Round three, `fix89c-report.md`: `7107c86a` fetched paths without control characters, `b933e483` Enola failure and coverage boundaries.

Round four, `fix89d-report.md`: `db288a81`, `5bcaafe4`, `9d64aeb4`, `ed2c324e`, and `22f088d2` for the coverage sweep.

Round five, `fix89e-report.md`: `91ad6b81`, `3e0692e2`, `80792297`, `3e80dfe8`.

Round six, `fix89f-report.md`: `eb78a45e`, `845a5f9c`, `c0dfa6dd`, `8198d8e2`.

Mutation inventory, `inv89-report.md`: 29 commits from the stopped session ending at `b87cd6a4`, among them `e79696db` for manifest record keys. The continuation added `f006ed04`, merge `41a60ddf`, `7224943b`, and merge `12d55a29`.

Round seven, `fix89g-report.md`: `0f79c884` trusted policy commit, `fc97a6a1` preceding tool calls, `3a010d43` escalation coverage.

Round eight, `fix89h-report.md`: `4533d448` tool pins in the run identity, `cae7df7e` and `363ade1c` uncheckable tools, `67bc9465` scratch sweep failures, `2cc6a0b1` graph coverage ID.

Round nine, `fix89i-report.md`: `9c74b5a8` cache notes out of the fingerprint, and a merge of `main`.

Round ten, `fix89j-report.md`: `fb13b7a6`, `d0c81e77`, and merge `8549c73d`.

Round eleven, `fix89k-report.md`: `e3086bd2`, `e611a86d`.

Round twelve, `fix89l-report.md`: `7320480a` canonical read paths, `18b5b204`, `e0575187`, and `a49059ce` for documentation.

Round thirteen, `fix89m-report.md`: `23d4abdf` publication inside the pin directory, `91c22068` the legacy window.

Round fourteen, `fix89n-report.md`: one fix that fails Enola closed on dropped results.

Round fifteen, `fix89o-report.md`: `18f7e5d3`, `5c90a137`, `3eb8ce60`, `2588be9e`.

Round sixteen, `fix89p-report.md`: a fix that reports a failed state-directory lookup as a message, and a style commit.

Round seventeen, `fix89q-report.md` (a later pass reused the name, so the file now holds round twenty-two's report): `95ff0167`, a commit that untracked tmp files, and a documentation commit.

Round eighteen, `merge89c-report.md`: `8ddb1a06`, `d086ba8f`, `af3b7b92` moving the record off the code branch, and `520ff5f8`.

Round nineteen, `fix89r-report.md` (reused by round twenty-three's pass, so the file now holds that report): `496bffb9`.

Round twenty, `fix89s-report.md`: `3aaeb838` dot-segment URLs, `373e80e7` miss rules, and `74a45a5a` the graph cache bound.

## Gates

Every pass ended on a green full gate. The last, after round twenty, passed with 101 test files and 2,582 tests passed, 2 skipped. Several passes saw timeouts under load. Each timed-out test passed alone, and the rerun gate passed.
