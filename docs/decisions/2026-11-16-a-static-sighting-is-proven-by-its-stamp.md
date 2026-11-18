# A static sighting is proven by its run's stamp

Amends: [A shared static finding carries no tool's text](2026-11-16-shared-static-findings-carry-no-tool-text.md), how a check run proves its sightings, and a static dismissal

Status: the coordinator's answer of 2026-11-16 on [issue #528](https://github.com/melian-agent/melian/issues/528), on approach. The maintainer ruled on 2026-11-17, in the coordinator's session, that this decision names the first two limits below and that this issue fixes neither. The coordinator answered on 2026-11-18, a message to the builder's session and not a ruling, that an empty result needs the proof too, and that [issue #562](https://github.com/melian-agent/melian/issues/562) owns the third limit.

## Problem

A static check's sightings leave the host only when the run that wrote them asked for check code that stores no tool text. Until now the proof was the run a review held: one `runChecks` returned in the same process, carrying its own request. Nothing tied that run to the sightings in the store.

Example: a caller runs the checks, then writes an older build's Biome sighting, with a login in its discriminator, into the same revision, and reviews. The run is genuine and current, so the export shares the planted sighting. A dismissal has the same gap the other way round: its sighting names no run, so no static dismissal could be shared at all.

## Decision

- The findings document keeps, for each revision and check, the full request key of the run whose terminal commit wrote every sighting that check has there: `checkRuns[revision][check]`. Findings version 12 adds it.
- The invariant: any write that changes a check's sightings at a revision deletes that check's stamp there, and only the check task's terminal commit writes one, after the sightings. `upsertFinding`, `replaceCheckFindings` and `clearSightings` are those writers. `replaceCheckFindings` writes the stamp last when given the run's key, even for a run that found nothing, and deletes it otherwise. A stamp names the check, never a producer, so a write of any version of the check deletes it.
- The checks document keeps each run's whole request by its key, `requests`, written once, when a run is first asked under that key. Checks document version 5 adds it. Nothing removes an entry: a stamp or a dismissal may name any key, and an entry is one request. A future prune, such as [issue #348](https://github.com/melian-agent/melian/issues/348)'s, must keep every key a stamp or a dismissal names. The requests stay in the local store; no record payload carries one, and no export reads them out.
- The check task carries the run's key, version 5, and the checks task passes it to each check, version 4. A build without the key refuses the task rather than write unstamped sightings for a run that expects a stamp.
- A static check's record that ran or is provisional is shared only if all four hold, with sightings or none, read from the store alone: the check's stamp at the revision equals the review's run's `request`; the checks document holds a request under that key; that request hashes to the key through core's `KeyedRequest`; and it asks for a version of the check that stores no tool text. `StaticProof` reads them. An empty result needs the proof too. Example: run B finds a blocker, then a stale run A of another request finishes, replaces B's sightings with none, and stamps A's key; B's record, exported without the proof, would call the revision clean. A skipped or failed check carries no result to prove. Otherwise the check exports as `failed`, with the code `withheld`, as before. Biome's proof and tsc's are separate: one check's failure withholds only its own record.
- `dismissFinding` keeps the stamp the winning sighting's check had when it was dismissed, as `dismissedSighting.run`. A later run's stamp does not change it. `ReviewRecords.dismissal` shares a static finding's dismissal only when `StaticProof` shows the request under that key asks for code that stores no tool text, and refuses it with `DismissError` `unprovenRun` otherwise. The dismissal's payload does not carry the key.
- The in-process brand on `CheckRun`, and the request it carried, are gone. A run handed in still must name the review's base, head and tier, or the review refuses it with `foreignCheckRun`.

The guarantee covers Melian's own writers and exported functions. Three limits stand outside it, and this decision fixes none:

- A forged request and key. A caller can store a request of its own making in the checks document, under the key it hashes to, and stamp that key. The store proves only that the request hashes to its key and asks for code that stores no tool text, not that a run of Melian's made it.
- A caller holding a storage transaction. A caller that writes the findings document by kind, through Pi Durable's documents or a transaction of its own, can write a stamp beside any sightings.
- The host's own verdict. A stale run of another request can still replace a newer run's sightings, since only the mutation check refuses a stale commit. The export withholds that check, but the host's own verdict reads the replaced sightings and can pass, until [issue #562](https://github.com/melian-agent/melian/issues/562) stops a stale run's commit.

`packages/pipeline/test/findings-check-stamp.test.ts` gives each writer a test where it alone deletes the stamp, and shows a run with no findings stamps, a later run restamps, and a dismissal keeps its own. `packages/pipeline/test/review-records-unproven-run.test.ts` shares a proven run's records, and withholds Biome's record for a missing stamp, another run's stamp, a request the store never kept, an edited stored request, and an older build's request. tsc's record, with no sightings, is withheld with them when the run is unproven, shared when only Biome's stamp fails, and withheld when another run stamped its empty result. `packages/pipeline/test/review-records-planted-sighting.test.ts` withholds Biome's record when the run handed in names another request the store keeps, which covers a caller pairing one run's records with another request and a request that shares a run's 16-character task key. `packages/pipeline/test/static-proof.test.ts` proves nothing for a root with no checks document, or for a stored request canonical JSON refuses.

## What this gives up

A static finding stored before findings version 12 has no stamp, so its check exports as `withheld` until the revision is reviewed again under this build. This change raises each static check's version in `checkVersions`, so the review asks each check again instead of reusing a run an earlier build completed under the same key, which wrote no stamp. A dismissal made before it has no `run`, so it stays unshared until the finding is dismissed again. A repeat of the same dismissal counts as a change when a different run now stands, so the same reason takes the new run's stamp.

A new dismissal's identity includes its `run`, so it differs from the identity the same dismissal had before. A dismissal made before the change keeps its identity, and the links that name it hold.

The checks document grows by one request per distinct key until a prune that keeps named keys exists.
