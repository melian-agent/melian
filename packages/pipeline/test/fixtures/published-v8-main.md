# Main's version-8 publication recording

`published-v8-main.json` contains two snapshots written by main at `942fe6c0`.
The producer source was exported with `git archive`, installed separately and left unchanged.
A byte comparison against `git show 942fe6c0:<path>` verified every exported package and script file.
Only the recording test was added. No old document shape was constructed.

The recorder drove `publishReview` against `fakeGitHub`, with fake models and memory storage.
It published an inline finding, a body-only finding and a protected, lowered trust-boundary claim.
It then dismissed the first two findings and published again.
One run refused the dismissal reply after accepting the review; the other refused the review.
Those runs captured recorded and pending resolutions, respectively.
Writer trust was false, so the snapshots also retain untrusted publisher attribution.
The repository changed `src/a.ts` from `old` to `new`, with both git dates set to `2026-10-18T00:00:00Z`.

The JSON retains each published-document snapshot verbatim, alongside its phase and producer metadata.
Companion verdict, publisher and fake-provider snapshots were omitted; the reopen test needs only the published document.
The test writes each snapshot through a version-8 token into SQLite, reopens with version 9 and checks the complete document.
Only the recorded or pending resolution map changes. Trust-floor diagnostics, attribution and pending payload survive.
A second reopen proves the persisted version-9 document stays unchanged, and a version-8 reader refuses it.

Recording test: `tmp/orphan-thread-pass6-record.test.ts`.
Recording output: `tmp/orphan-thread-pass6-fixture-writer.log`.
Source comparison: `tmp/orphan-thread-pass6-producer-proof.txt`.

## Version-2 boundary recording

`published-v2.json` was written by unchanged publisher code at `9367190cb48904b43e53b9804971189049439aab`.
An isolated archive ran that commit's fake-model test, “answers a dismissed finding's thread with the reason”.
The only test change captured `harness.snapshot(PublishedDocument, root, context)` after its final publication.
This records a dismissal reply under the finding ID, before version 3 introduced thread and dismissal keys.
Its SQLite reopen test kills the boundary mutant that starts the version-3 branch at version 2.
Recorder and output: `tmp/orphan-thread-pass6-v2-record.test.ts` and `tmp/orphan-thread-pass6-v2-writer.log`.
