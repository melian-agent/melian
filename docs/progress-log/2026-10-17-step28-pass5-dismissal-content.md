# Step 28 pass 5: dismiss the accepted content

[Pull request #142](https://github.com/melian-agent/melian/pull/142), review-of-record F1.

A maintainer dismissed B, then a force-push returned to reviewed head A with different content.
The real review and dismissal probe returned success on that second A before the fix.
It now fails. A revision with the accepted trigger stays dismissed.

New dismissals record their revision’s trigger hash and affected proof hashes in findings document version 9.
Sightings compare with that content regardless of revision order. Last-seen order stays unchanged.
Attached tasks also check their stored sightings before verification and adjudication.
A reopen invalidates adjudication at every sighted revision.
Affected findings retain the proof-union rule, so changed citations alone never reopen them.

A fixture written by main at `e0a9d00f` proves version-8 dismissal behaviour survives SQLite migration.
The test then records a new dismissal and proves its content binding survives another reopen.
The sandbox refused a new worktree’s administrative directory; main’s archived package sources wrote the fixture instead.

Validation: the regression failed first with expected failure, received success.
The code-finding cases failed first with expected new, received dismissed.
After the fix, 118 tests across four files passed, as did type checking.
Hand mutations killed the new trigger, proof, revision-order, cached-review and invalidation changes.
The version-8 fast-path removal is equivalent to its identity upgrade.
Refresh’s status check is redundant under the stored invariant that only dismissed records have an accepted trigger.
The coordinator must run `static.mutation` on the host; the sandbox denies `ps`.
The whole gate follows this pass. The implementation plan stays unchanged.
