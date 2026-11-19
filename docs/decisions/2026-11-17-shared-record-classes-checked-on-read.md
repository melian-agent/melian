# A shared record's classed fields refuse free text when it is read

Status: builder agent's approach for [issue #548](https://github.com/melian-agent/melian/issues/548), which the coordinator filed. It is not a maintainer's ruling.

Amends: [A shared record carries no text a tool, a provider or the head wrote](2026-11-16-shared-records-carry-no-outside-text.md), the classes: core's payload schema holds each class the producer applies.

## Problem

That decision sorted every string field of an exported record into seven classes and applied them where `ReviewRecords` builds a record. The payload schema a reader checks, `packages/core/src/record-payloads.ts`, still typed many of those fields as any non-empty string. So a record Melian never built passed the reader with free text where a hash belongs.

Example: a check record whose Enola snapshot held `snapshotId: "ghp_token"` passed `SharedRecord.checked(reviewPayloads)`, and the relay of [issue #397](https://github.com/melian-agent/melian/issues/397) would write it to `melian/state`. Getting such a file to the relay takes something like a sandbox escape, but the relay and the merge-group check are the boundary meant to hold then.

## Decision

Core's schema holds each class, and the producer takes each from core, so there is one copy.

- **IDs and hashes.** A snapshot's `commit` is a git object ID, `objectIdPattern`. Its `snapshotId` is `snapshotIdPattern`. Its `cacheKey`, every coverage ID, and a dismissal's trigger and proof hashes are `hashPattern`, the 64 hex digits of a SHA-256. Its `receipt` is Melian's sentence or what `isReceipt` takes: the three fields `receipt()` keeps, in the order it writes them, with an Enola version in semver's own form, which `valid` decides, as `isToolVersion` does. `enola-static.ts` refuses a receipt whose version is not the pin in `tools.yaml`, and every pin has been one, 0.4.27 and then 0.4.40. `ReviewRecords` tests each against the same exports. A decided check's coverage ID that is not a hash reads `null`.
- **Versions.** A lens record's version is 12 hex digits, as `versioned` in `core/src/lens.ts` computes it. A lens finding's source is that version, `@`, and a scrutiny level. The verifier's version is 16 hex digits, as `verifierVersion` computes it, and a claim's verification names it, since the verifier ran that verification. Any other check's version is a tool's, which `isToolVersion` decides: semver's own form of at most 64 characters, or `unavailable`, else Melian's sentence. The schema checks a version wherever it appears: a check's result, a decided check, a verification's claims, an account's filled checks and producers, and a dismissal's sighting.
- **Codes.** A reason or error is one of `recordCodes`, the check error codes, the task outcomes, `no record`, `unexpected`, `withheld` and `unkeyed`, or Melian's sentence. A failed check's reason is a code alone, and its error is the sentence alone. A caveat is `blindCallers`, `lightTriage` or the sentence. A lineage's thinking level and wanted level are one of Pi's levels or `unset`. A telemetry stage's outcome is one of `telemetryOutcomes`, the ends `telemetry.ts` names a stage by and the `ran` and `reused` it names a run's row by, or `withheld`; `ReviewRecords` withholds any other.
- **Keys.** A dismissal's key is a finding's ID, `findingIdPattern`, whose length comes from `findingIdDigits`, the digits `Finding` keeps of its hash. Each kind a writer's job relays, check, lens, verification, walkthrough, triage, round, account and telemetry, is keyed by its request, `hashPattern`, and so is each key a round's manifest names. A marker and the four kinds no command writes yet keep any non-empty key until one does. A dismissal's key is checked for its form here; its binding to its sighting's finding ID belongs to [issue #481](https://github.com/melian-agent/melian/issues/481), the first code that reads dismissal records. Tests make a valid key from a label with `recordKey` and `findingKey` in core's testing entry. A verification outcome's `candidate` is a finding's ID too, `findingIdPattern`: `review.ts` keys each candidate by its speaking finding's ID, `defect.speaker.id`, and writes `verified.result`'s keys as the candidates. Every verification an earlier build of `main` wrote holds one, as `review-records-main.test.ts` reads.
- **Times.** A dismissal's `at` is a time `toISOString` writes, to the millisecond in UTC, and the check compares it with that function's output, never with a copy of its format.
- **Notes.** A check's `notes` hold nothing, since the producer empties them.
- **Messages.** A refusal names the field by its path and never repeats text the record holds: not the field's value, which may be the text the record must not hold, and not a name the record supplies, such as a producer's or a check's. `packages/core/test/record-refusals.test.ts` walks each kind's schema for its string fields, puts a sentinel holding a terminal escape and a bidi control in each, alone and beside each other refusal a record can reach, and fails when a refusal repeats it or a schema gains a string field no sample holds. A schema path keeps the segments the schema names and array indices, and shows any other segment as `*`, since a map's key is the record's own text. One refusal names text from the record: an unknown kind, which the store conformance suite requires a refusal to name.

The payload version stays 1. Every record a current Melian writes already matches, so a reader of version 1 still reads everything written. `packages/pipeline/test/review-records-main.test.ts` proves it: it reads records main's build wrote at e6ed960bd, captured from its own tests that build records, and asserts the new schema accepts each. They cover every kind a review writes: check, lens, verification, walkthrough, account and round. `ReviewRecords` writes triage, telemetry and dismissal records only in tests today. The capture holds triage and telemetry records; no main test built a dismissal record, so `packages/core/test/record-payload-classes.test.ts` checks one written as `ReviewRecords.dismissal` writes it.

### Fields that stay free text

Each is one of the earlier decision's classes that the schema cannot close without a second copy of an answer the producer does not own:

- Class 4, names Melian or the base's configuration gives: a check's and a lens's name, a model, a route and the routes a lens tried, a triage decider and its question set, a telemetry stage's name and models, a lineage's `wanted`, `by`, `thinking.by`, `moved` and `outside`, and an escalation's `to`, a run key Melian builds from a time, a scope and a level.
- Class 5, paths: a dismissal's proof file and a walkthrough's file paths.
- Class 6, the review's content: a finding's text, which `Finding.parse` checks, a verdict's reason, and a walkthrough's text.
- Class 7, a dismissal's `by` and `reason`, which a writer wrote.

A name in class 4 comes from the base's configuration, which a writer controls, so it is not the head's text.

## What this gives up

A tool's version is still up to 64 characters of the head's choosing in semver's form, as the earlier decision accepted. The head may choose up to 64 letters, digits, hyphens and dots, and `+` is outside that set, so a version with a build tag, such as `1.2.3+linux.1`, is withheld; the earlier decision's "build tags stay" yields to its own narrower limit. An unknown kind's refusal repeats the kind, at most dot-joined segments of `[a-z0-9-]`, because a store must say which kind it refused.

Core computes the lens version and pipeline the verifier's, and core cannot import pipeline, so both lengths live in core, `lensVersionDigits` and `verifierVersionDigits`, and each producer cuts its hash with them. `record-payload-classes.test.ts` reads every built-in lens's version against the schema, and `packages/pipeline/test/review-records-classes.test.ts` keeps the verifier's own version, so a drift fails there first.
