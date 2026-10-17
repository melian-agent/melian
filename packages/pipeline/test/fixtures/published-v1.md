# Version-1 publication recording

`published-v1.json` contains pending and completed snapshots from `ef99429f39e4ec93766632936b9525818d9688ed`.
Its unchanged version-1 publisher ran through `publishReview`, using that commit's fake GitHub and fake models.
An isolated `git archive` export installed its own locked dependencies.
All 187 exported package and script files matched the archive byte for byte after recording.
Only the recording test was added.

The recorder reported an affected finding on `src/user.ts:19`, citing changed line 7 as evidence.
The fake provider refused its first review, leaving a pending round with the original single-location evidence.
The provider then accepted the review, leaving a completed record without a pending round.
The recorder copied both published-document snapshots verbatim.

The reopen test writes each snapshot through a version-1 token into SQLite and closes the harness.
Version 9 upgrades the pending finding and verdict evidence, and supplies the legacy publisher attribution.
The completed record survives without acquiring a pending round.
A write persists version 9; another reopen checks the full document, and a version-1 reader refuses it.

Recorder: `tmp/orphan-thread-pass7-v1-record.test.ts`.
Output: `tmp/orphan-thread-pass7-v1-record.log`.
Source comparison: `tmp/orphan-thread-pass7-v1-producer-proof.txt`.
