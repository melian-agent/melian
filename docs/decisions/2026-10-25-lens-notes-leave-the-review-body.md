# Lens notes leave the review body; a caveat on the whole review stays

Status: accepted by the maintainer, 2026-10-25, in [issue #212](https://github.com/melian-agent/melian/issues/212).

Amends: [Findings read in one register, with emojis and a set English](2026-10-24-finding-register.md), row 21 of "What every renderer keeps", the notes of lenses that ran.

## Problem

The review body listed every lens that ran with a note, and the note in full. The notes are for someone tuning Melian. A reviewer cannot act on them, and they change nothing about what the review covered.

Example: [pull request #201](https://github.com/melian-agent/melian/pull/201)'s published review repeated seven "Callers unavailable for <file>: line N: directory-scoped name is ambiguous" notes, and "triage input was cut, so no lens could skip", under each of eight lenses: about 50 lines. Caller context is an optional input; a note records why one site got no answer. A cut triage input let no lens skip, so every lens ran. Neither narrowed the review. A lens that a budget ended, failed or skipped already appears under the checks that did not run. The README promises that Melian is quiet; this broke it.

## Decision

1. The pull-request review body, and the ledger's summary, which renders it, no longer list "Lenses that ran with a note".
2. Every note stays where someone tuning Melian looks: on the check record's `reason`, so in `melian findings --all --json`, `melian review --json` and the terminal verdict, and in the ledger's collapsed run details. There each distinct note appears once, beside the lenses that carry it.
3. A caveat reaches the review body: a note that changes how far the reader can trust the whole review. It is one line, `Reach: <caveat>.`, after the summary and before the status mapping, however many lenses carry it. Two conditions qualify, because each held for the whole review and narrowed what every lens could see:
   - no changed site got callers: the caller context was absent or unavailable, or every caller query failed. The caveat reads "callers were unavailable for every changed site, so no lens saw who calls the changed code", then the reason.
   - triage chose quick for every lens of a review whose change can steer triage.
   A note about one lens or one site is not a caveat, and neither is one that widened the review, such as a cut triage input.
4. A check record carries its caveats in a `caveats` field, so a renderer reads them rather than matching note text. The lens task's caller input and the review index carry the caller caveat beside the caller notes, so a repeat review keeps the first call's caveat as it keeps its notes.
5. The caller query skips test files. Nothing calls a test's callbacks, so the query only produced ambiguity notes and spent Enola time ([issue #208](https://github.com/melian-agent/melian/issues/208)). It uses `testPath`, the predicate the mutation selector shares.

Where this decision and row 21 of the register's table conflict, this decision wins. The terminal keeps every note, as row 21 says.

## Stored shapes

`CheckRecord` gains an optional `caveats`; the verdict document moves to version 13 and the adjudication task to version 6. The lens task's caller input gains an optional `caveat`, moving that task to version 5; the review index's caller record gains one, moving it to version 4. Every migration reads the older shape unchanged, and none invents a caveat. `packages/pipeline/test/caveats-reopen.test.ts` reopens a store main wrote at `460f68f0`.
