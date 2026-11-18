# A review counts a static check's findings only from its own run

Amends: [A static sighting is proven by its run's stamp](2026-11-16-a-static-sighting-is-proven-by-its-stamp.md), which now binds the host's verdict as well as the export

Status: the maintainer ruled on 2026-11-18, in the coordinator's session, on [issue #562](https://github.com/melian-agent/melian/issues/562): a review counts a static check's findings only when the stamp on them is that review's own run, the verdict applies the export's proof inside the commit that decides, and a replaced check reads as not run. The coordinator agreed the plan's four details on 2026-11-18, [recorded on the issue](https://github.com/melian-agent/melian/issues/562#issuecomment-6974131565); that answer is not a ruling.

## Problem

A static check writes its findings into one slot per check and revision, and the newest write wins. The adjudication read that slot and counted whatever was in it, whoever wrote it. The export checked the stamp; the verdict did not.

Example: run A of `static.tsc` starts. Run B starts later, finds a type error, and its review blocks. Run A, slower, finishes with no findings and overwrites the slot. B's review runs again, reuses B's run as finished, reads A's empty findings, and passes. A P0: a blocker stops blocking with nothing changed.

## Choice

1. The adjudication task's input names the run its review holds: its identity and its request. In its decide phase, and again inside the commit that records the verdict, it asks `StaticProof.replaced` which static checks the run's records say ran, or ran provisionally, and whose stamp at the revision the store does not prove to be that run's. `StaticProof` is the export's own proof, so the verdict and the export call one function.
2. A replaced check reads as `failed`, with the reason that another run replaced its findings and a repeat review runs it again, and the findings in its slot are dropped. A configured check that did not run means not approved, by the maintainer's rule of 2026-10-14, so the verdict reads not reviewed.
3. If the commit finds a check replaced that the decide phase did not, it decides again with both, before it records. A write that lands between the review taking its run and the verdict reading is caught either way.
4. `runChecks` reuses a finished run only while the store still proves each of its checks to be that run's. Otherwise it starts a new run, so a repeat review runs the check again and decides, and never loops on a replaced run.
5. A review handed bare check records, with no run, gets no proof, so the verdict counts the records as the caller gave them. The export still withholds their static sightings. This is the builder's choice, put to the coordinator on 2026-11-18; failing such a review closed would change about 39 test files for callers that are all tests.
6. The host's verdict is laxer than the export for a run whose request `checkReusable` refuses. The verdict counts such a run's findings when its stamp is its own, since this host's run did write them. The export reads it `failed`, `unkeyed`, since another host could not tell two runs under that key apart. A round's shared verdict is computed from the exported records, so it is the stricter of the two.
7. The adjudication task moves to version 8. A version-7 task holds no run, so a resumed one proves nothing and reads its replaced checks as not run. A reopen test resumes a task that main's code at e421b5541 wrote.

## Why not the alternatives

- Reading the stamp in the verdict alone, outside the commit, leaves the window between the read and the record. The commit serialises writers, by the design's rule that a writer proves ownership in the commit that writes.
- Keeping one slot per run would change the stored findings shape and every reader of it, to fix what a check at read time already fixes.
