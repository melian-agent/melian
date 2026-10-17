# Publication asks the provider for thread state

Status: design for attacking review, before implementation.

This extends publication recovery without replacing its signed markers, target checks, dismissal rules or status mapping.
It follows [Ask the authority](2026-10-12-ask-the-authority.md) and the [convergence rules](2026-10-15-review-loop-convergence-rules.md).
It addresses [issue #132](https://github.com/melian-agent/melian/issues/132) in [pull request #145](https://github.com/melian-agent/melian/pull/145).

## Problem

Publication remembers replies it owes, but that record can disagree with GitHub.
A reply may have reached GitHub before a crash lost its checkpoint.
A finding may have reopened since an earlier round planned its dismissal.
A round may have recorded a resolution before another review returns the finding to the same thread.

For example, H1 posts F in thread T.
H2 reports nothing, but editing and resolving T fails.
H3 carries the resolution, records its review, and crashes before editing T.
A fresh review of H3 reports F again.
Publication restores T to its open set, then executes H3's older resolution and closes T.
GitHub still had an open thread until Melian acted on the stale instruction.

## Authority and read boundary

GitHub is the authority on a thread's existence, resolved state and posted answers.
The current decided verdict remains the authority on whether Melian holds a finding or dismisses it.
A human resolving a thread never dismisses a finding in Melian or changes the verdict's status.

Add a provider read through core's `ReviewProvider` port.
It returns a snapshot keyed by the original comment ID, which publication already stores as `thread`.
For each thread publication might reuse, answer or resolve, the snapshot gives:

- The original comment ID, GitHub thread node ID, and `isResolved`.
- The signed finding identity and original publication revision, when present.
- Every verified resolution or dismissal marker in that thread, including its revision, finding ID and dismissal version.
- The comment ID carrying each answer, including an addressed edit on the original comment.

Read the union of threads in the published open sets, owed resolutions, changed dismissals and pending rounds.
Include pending posts recovered through their signed markers, even when their thread IDs were never recorded.
GraphQL supplies thread existence and `isResolved`; REST's paged review comments supply complete bodies and reply parents.
Do not ask GraphQL for only a thread's first reply and infer that no other answer exists.
Existing signature verification and author filtering apply unchanged.
A copied marker in another thread does not answer this one; use the actual root comment ID as well as its signed identity.

Read once per publish task attempt, before planning or executing any pending round and before the first external write.
Reset provider caches at that boundary.
Fetch all pages before using any result.
Use the same snapshot for both an older pending round and the current round in that attempt.
Update its in-memory facts after this publisher's successful writes; a crash discards it and the next attempt reads again.
Resuming an unfinished task also starts with a fresh read.
The snapshot is never a durable memo or a stored authority.

An absent known thread is gone only after a complete successful read.
An inaccessible pull request, partial response, GraphQL error, failed page or malformed pagination is a failed read, not an empty set.
Fail the publication without posting any reply, editing any finding comment or resolving any thread.
Do not plan a new review from partial thread state or fall back to the stored open and answered flags.
This preflight precedes writes, so it also leaves review, ledger and status writes for a later successful attempt.
The existing status-first rule still orders the writes after preflight succeeds.

## Planning and executing

The planner reconciles stored candidates with that snapshot and the current verdict.
It never treats an absent local reply checkpoint as proof of an unanswered thread.

| Provider state and current finding | Plan |
|---|---|
| Thread resolved or gone | Send no reply, edit or resolution. A live finding needing publication gets a fresh thread. |
| Open, with the exact signed dismissal already present | Do not repeat that dismissal. A different dismissal version can earn a new reply. |
| Open, addressed edit present, finding absent from the current verdict | Resolve without repeating the edit. |
| Open, no posted answer, resolution owed, same finding live again | Reuse the thread only when it was not dismissed. Cancel the obsolete resolution. |
| Finding reopened after dismissal | Post it in a fresh thread, even if the old dismissal reply never reached GitHub. |
| Open, absent or currently dismissed finding, no matching answer | Plan its current resolution or dismissal once for that thread. |

A dismissal reply alone does not imply `isResolved`.
The current GitHub adapter posts dismissals without resolving their threads; this design keeps that behaviour.
An addressed edit alone does not imply resolution either: a crash can fall between the edit and GraphQL mutation.
An open thread with that edit and no live finding still needs its resolution.
An open thread with an addressed edit is not reused for a live finding; its old answer belongs to the earlier occurrence.

Thread reuse and resolution ownership are one planning operation.
The final plan maps each reused thread to its current finding and round.
Only a resolution planned for that assignment can close it.
A thread held live by the current verdict cannot also appear in that plan's resolutions.
Check held member IDs as well as speaker IDs, so merging a report does not close its live thread.
Reopening a dismissed finding always starts a new assignment in a new thread.

Keep the review payload of a pending round immutable for signed recovery and step 28's dismissal attestations.
Recover or post that payload as today, then reconcile the current verdict before executing any thread action.
An older round's `resolved` entries are candidates, never executable instructions by themselves.
Execute only the final plan's thread actions; do not scan every historical `record.resolved` and replay it.
When committing a reused thread to `open`, retire outstanding resolutions for that same thread in the same commit.
Preserve the historical reply journal and review attestations.
Do not add a second durable ownership registry: the plan's revision, round, finding and thread supply the assignment.

The current verdict may still owe a dismissal on an earlier thread after the reopened finding gets its new thread.
That answer belongs to the earlier assignment and cannot resolve or answer the new thread.
The provider snapshot suppresses it if the exact dismissal already reached GitHub or the earlier thread is resolved.

## API cost

The snapshot uses one paged thread query and one paged review-comment list per attempt with thread candidates or a pending round.
At 100 entries per page, let G be `max(1, ceil(threadCount / 100))` and C be `max(1, ceil(commentCount / 100))`.
Its read cost is G + C calls: normally two for a pull request with at most 100 threads and 100 review comments.
There is no call per owed finding or per historical head.
A publish with no thread candidates and no pending round needs zero snapshot calls.
Threads returned by a new review post enter the in-memory snapshot from the accepted post.

Reuse these comment pages for signed-marker discovery throughout the attempt instead of listing comments for each head or round.
Review-marker discovery still reads review pages separately.
The GraphQL pages replace the existing lazy thread discovery on the first addressed resolution.
For an attempt that already lists comments and resolves a thread, this moves those reads earlier with no extra calls.
An attempt that lists comments but only posts dismissals adds G calls, normally one.
The conservative cost without either existing read is G + C extra calls, normally two.
The existing cached user lookup, target revalidation, status and ledger reads remain separate and unchanged.
Publication calls no model.

## Stored state

Keep `PublishedDocument`'s review IDs, round counters, pending review payloads, thread identities and reply IDs as a recovery journal.
Keep which dismissal was intended and the commit that addressed a finding; GitHub cannot decide those policy facts.
Keep its existing shape for the first implementation; this decision requires no new stored field or migration.

Stored `open`, `resolved`, `replies` and `threadResolutions` remain useful candidates and checkpoints.
They cease to prove that a thread is open, unresolved or unanswered now.
In particular, the provider read replaces the per-owed-entry `findPublished` probe and the local inference that its marker means a resolved thread.
The historical resolved maps are redundant as a work queue.
Retain them as journal/cache data, reconciled before use, rather than adding another migration merely to delete them.
No stored cache can bypass a failed provider read.

## The three instances

1. **Reply reached GitHub, record lost in a crash.** The snapshot finds the signed answer and actual resolved state before reuse. No repeat answer or reuse of a resolved thread follows.
2. **Owed dismissal reused by a reopened finding.** Dismissal history and the current verdict require a fresh thread. The provider decides whether the old thread still needs its own answer.
3. **Crash during a pending round closes a thread later reused.** Recovery preserves the old review payload, but the final current plan owns thread actions. Reusing T cancels its old resolution before any reply or resolution runs.

The second regression is already guarded on the merged head.
Its reproduction must retain the finding ID while changing its trigger; changing the snippet creates another ID and tests nothing about reuse.
The third needs SQLite and a real kill after the clean round's review-record commit, followed by a review-only reopen.
Neither test may replace `publishReview` or the fake GitHub with a direct planner call.

## Limits and next phase

GitHub does not offer an atomic snapshot-and-write transaction here.
A human can change a thread after the read; once-per-attempt reads do not promise serialisation with external actors.
The three failures above concern state already present before planning and stale instructions Melian itself retained.
Existing target checks still run before writes, and provider failures still stop the task with earlier accepted effects recorded.

The attacking review must probe pending-round recovery, same-head replacement, merged members, resolved threads, deleted threads and pagination failures.
Implementation follows that review, with provider query assertions and failure-path tests.
Step 28's status mapping, dismissal attestations and version-9 findings lifecycle remain intact.
