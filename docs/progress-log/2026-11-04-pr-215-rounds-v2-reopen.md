# Reopen main's version-2 rounds

[Pull request #215](https://github.com/melian-agent/melian/pull/215) merged main's caveat migration with the branch's round-key migration at `741c00de`. Commit `d2977a24` adds the missing SQLite fixture and reopen test. The fixture was recorded by main at `0b3a0c4ba8cfc30adf84f94afad1d52ba881b742`, after [pull request #217](https://github.com/melian-agent/melian/pull/217) merged.

The capture starts with the real version-1 head-only fixture. Main's version-2 writer migrates it and records a second round through its own adjudication task. That task receives a caller-unavailable reason without a caveat and a skipped lens with an explicit triage caveat. The fixture README records the source commits and reproduction steps. Tests copy the SQLite file before opening it.

The new test asserts the complete migrated rounds and document with `toEqual`, through detached reads and a reopened harness. The head-only round gains its split identity and retains its original key. The decided round keeps its explicit caveat and gains the caveat encoded in its legacy reason.

The migration needs no source-version branch. `Round.upgrade` changes only `base`, `head` and `legacyKey`. The caveat conversion changes only verdict records and preserves existing caveats. Both conversions preserve fields the other changes, including on either earlier version-2 shape.

The full test name is `reopens main's version-2 rounds with split legacy keys and preserved verdict caveats`. Each hand mutation ran that test alone, selected by its anchored full name:

| Mutation | Result | Evidence |
| --- | --- | --- |
| Drop `Round.upgrade` | Killed, exit 1 | The head-only round keeps the old base and empty head and lacks `legacyKey`. |
| Drop `verdictWithLegacyCaveats` | Killed, exit 1 | The decided round lacks its caller-unavailable caveat. |
| Apply caveats before `Round.upgrade` | Equivalent, exit 0 | The conversions change separate fields and preserve each other's results. |

The requested order swap cannot fail a behaviour test: it produces the same stored JSON. A call-order assertion would impose an ordering the migration does not need. Production source was restored after every probe and remains unchanged.

The baseline test passed on `741c00de`; the reported gap was missing reopen coverage, not a failing production migration. Both deletion probes then failed for the intended losses. The restored test passed again. All 43 tests in `rounds.test.ts`, type checking and the targeted Biome check pass. The full gate was not run in the sandbox; the host owns it.

Enumeration of `741c00de...d2977a24` with limit 10,000 produced zero mutants and zero omissions: this pass changes tests and fixtures only. The complete inventory, hand-mutation script and individual logs are in the task's scratch directory, `/Users/tal/dev/Melian/tmp/m2/codex-delta-build-v3/`. The branch diff review found no further defects. This coverage pass changes no design decision or plan status.
