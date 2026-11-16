# A static sighting is proven by its run's stamp

Amends: [A shared static finding carries no tool's text](2026-11-16-shared-static-findings-carry-no-tool-text.md), how a check run proves its sightings, and a static dismissal

Status: the coordinator's answer of 2026-11-16 on [issue #528](https://github.com/melian-agent/melian/issues/528), on approach. It is not a maintainer's ruling. Whether a caller that writes the store by kind is outside the guarantee goes to the maintainer.

## Problem

A static check's sightings leave the host only when the run that wrote them asked for check code that stores no tool text. Until now the proof was the run a review held: one `runChecks` returned in the same process, carrying its own request. Nothing tied that run to the sightings in the store.

Example: a caller runs the checks, then writes an older build's Biome sighting, with a login in its discriminator, into the same revision, and reviews. The run is genuine and current, so the export shares the planted sighting. A dismissal has the same gap the other way round: its sighting names no run, so no static dismissal could be shared at all.

## Decision

- The findings document keeps, for each revision and check, the full request key of the run whose terminal commit wrote every sighting that check has there: `checkRuns[revision][check]`. Findings version 12 adds it.
- The invariant: any write that changes a check's sightings at a revision deletes that check's stamp there, and only the check task's terminal commit writes one, after the sightings. `upsertFinding`, `replaceCheckFindings` and `clearSightings` are those writers. `replaceCheckFindings` writes the stamp last when given the run's key, even for a run that found nothing, and deletes it otherwise. A stamp names the check, never a producer, so a write of any version of the check deletes it.
- The checks document keeps each run's whole request by its key, `requests`, written once, when a run is first asked under that key. Checks document version 5 adds it. Nothing removes an entry: a stamp or a dismissal may name any key, and an entry is one request. A future prune, such as [issue #348](https://github.com/melian-agent/melian/issues/348)'s, must keep every key a stamp or a dismissal names. The requests stay in the local store; no record payload carries one, and no export reads them out.
- The check task carries the run's key, version 5, and the checks task passes it to each check, version 4. A build without the key refuses the task rather than write unstamped sightings for a run that expects a stamp.
- A static check's record that carries sightings is shared only if all four hold, read from the store alone: the check's stamp at the revision equals the review's run's `request`; the checks document holds a request under that key; that request hashes to the key through core's `KeyedRequest`; and it asks for a version of the check that stores no tool text. `StaticProof` reads them. A check with no sightings at the revision holds no tool text, so its record is shared as before. Otherwise the check exports as `failed`, with the code `withheld`, as before. Biome's proof and tsc's are separate: one check's failure withholds only its own record.
- `dismissFinding` keeps the stamp the winning sighting's check had when it was dismissed, as `dismissedSighting.run`. A later run's stamp does not change it. `ReviewRecords.dismissal` shares a static finding's dismissal only when `StaticProof` shows the request under that key asks for code that stores no tool text, and refuses it with `DismissError` `unprovenRun` otherwise. The dismissal's payload does not carry the key.
- The in-process brand on `CheckRun`, and the request it carried, are gone. A run handed in still must name the review's base, head and tier, or the review refuses it with `foreignCheckRun`.

The guarantee covers Melian's own writers and exported functions. A caller that writes the findings document by kind, through Pi Durable's documents or a transaction of its own, can write a stamp beside any sightings, and is outside it.

`packages/pipeline/test/findings-check-stamp.test.ts` gives each writer a test where it alone deletes the stamp, and shows a run with no findings stamps, a later run restamps, and a dismissal keeps its own. `packages/pipeline/test/review-records-unproven-run.test.ts` shares a proven run's records, and withholds Biome's record for a missing stamp, another run's stamp, a request the store never kept, an edited stored request, and an older build's request, while tsc's record, with no sightings, is shared.

## What this gives up

A static finding stored before findings version 12 has no stamp, so its check exports as `withheld` until the revision is reviewed again under this build. A dismissal made before it has no `run`, so it stays unshared until the finding is dismissed again.

A new dismissal's identity includes its `run`, so it differs from the identity the same dismissal had before. A dismissal made before the change keeps its identity, and the links that name it hold.

The checks document grows by one request per distinct key until a prune that keeps named keys exists.
