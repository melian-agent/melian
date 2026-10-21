# Publication returns an owed finding to its own thread

Status: accepted, implementation in this change.

This extends publication recovery without replacing signed markers, target checks, dismissal rules or status mapping.
It addresses [issue #132](https://github.com/melian-agent/melian/issues/132) in [pull request #155](https://github.com/melian-agent/melian/pull/155).
It takes the thread-state rules of [pull request #145](https://github.com/melian-agent/melian/pull/145) and leaves out its publisher-identity rules.

## Problem

A resolution whose reply failed stays owed, and a finding can return before the reply goes through.
For example, head 1 posts F in thread 1002, and head 2's edit of 1002 fails.
Head 3 reports F again, and head 4 posts F afresh in thread 1009.
Thread 1002 stays open for good, so a repository that requires resolved conversations cannot merge.

A reply may also reach GitHub before a crash loses its checkpoint.
Head 1 posts F in T, head 2 plans its resolution, and head 3 records that resolution before crashing.
A new review of head 3 reports F again.
Reusing T without retiring that instruction lets the closing pass resolve a live finding's thread.

## Decision

Write the current verdict's status before reading any thread or publication marker, including recovery of an older pending round.
A failed thread read must never leave an older success standing on the same head after its base changes.
Step 28's mapping, dismissal attestations and version-9 findings lifecycle stay unchanged.
Publication calls no model.

Keep the existing provider port and widen `findPublished`'s answer markers to every head.
Review and finding-root recovery still match the requested head; answers are keyed by finding, actual root comment and dismissal version.
A recovered root belongs to the recovered review only when its `pull_request_review_id` names that review, since one head can hold roots for a finding in several reviews.
An answer counts when either the durable journal or GitHub records it.
A deleted reply is not repeated when its journal entry survives.
An addressed edit counts only on its own signed finding root.
A reply counts only when its author matches its signed root's author.

Read GraphQL thread state lazily, when publication will reuse, answer or resolve that thread.
Cache complete reads within one attempt and reset them on replay.
A still-open finding is never reposted merely because a human resolved its thread, and it continues to count in the status.
Before posting a review, publication reads the state of each still-open finding's thread.
The review body lists a still-open finding again only when a human resolved its thread or the thread is gone; an open thread is not repeated.
A returning finding cannot reuse a human-resolved thread.
Answers still owed to a human-resolved thread are posted; resolving it again is a no-op.
A known root absent from GraphQL but present in REST is not gone.
Its resolved state is unknown, so publication waits for GraphQL before reusing or resolving it.

Reuse requires an undismissed returning finding, no answer in either source and an open thread.
In the commit assigning a thread to the live plan, retire every outstanding resolution against that thread across all heads, including this head.
Keep the reply journal and review attestations.
Recover a pending review's immutable payload as before, then plan the current verdict before executing thread actions.
Only the resolutions remaining after those assignments may execute.

An addressed edit and thread resolution are separate effects.
If the edit landed but resolution did not, resolve that old thread on the next publish, whether or not its finding is live.
A returning finding gets a new thread; the old thread's resolution depends on its assignment, not the finding ID.
A reopened dismissal also gets a new thread, even when the old dismissal reply is still owed.
Dismissal replies keep their existing behaviour: they do not resolve threads.
When a dismissal reason changes, the commit that queues the new reason on a thread drops every earlier reason for that thread that no reply carried, in the journal or on GitHub. An answered reason stays as history. Only the current reason reaches the reply loop, as when resolutions were keyed by finding.

## Publisher identity stays as main has it

Who counts as Melian is unchanged.
A marker is ours when its signature verifies and its author is the token's login, or on its signature alone when the login is unknown.
This change does not bind roots to signed reviews, prefer Bot authors or the lowest review ID, record the publisher across tokens, or change how `login()` treats a refusal.
[Issue #154](https://github.com/melian-agent/melian/issues/154) holds those rules.
Five rounds on #145 each found a new identity defect in code an earlier pass had added, so they get a design of their own.

## Complete reads and cost

Bound each review, comment and GraphQL thread listing at 50 pages of at most 100 entries.
Fail on a failed page, GraphQL errors, partial or malformed data, a missing next cursor, or a repeated cursor.
Validate every REST record's IDs, author, body and comment links; a comment's parent review ID and reply link may be null or absent.
Fetch all pages before using any results; never substitute stored flags for a failed read.
The status is already current; subsequent thread, review and ledger work waits for a successful attempt.
A root deleted between read and write still takes the existing 404 recovery.
GitHub offers no atomic read-and-write transaction, so these reads cannot serialise human edits after the read.

Reuse the cross-head answer listing for planning and closing, replacing per-entry, per-head probes.
A normal new round already lists reviews and comments; widening their interpretation adds no REST call.
GraphQL adds its paginated read only when there is a thread action or a review to post over still-open threads.
Reuse and dismissal-only attempts may therefore add that read.
A settled rerun with nothing owed lists no publication markers and reads no threads.

## Several owed threads per finding

One resolution per finding ID is not enough.
An older addressed thread could fail to resolve until a newer thread for that finding resolved, and carrying only the newer thread lost the older instruction.

Published-document version 9 keys resolutions by finding, actual root comment and dismissal version, using `replyKey`.
Each entry keeps its finding ID. Body-only resolutions keep the finding ID as their key.
Planning, pending rounds and closing preserve every owed thread.
Current resolutions run before carried work, so one failed older thread cannot hide a newer thread's resolution.
The migration rekeys recorded and pending resolutions and leaves the pending review payload and trust-floor diagnostics intact.
Versions 1 to 8 all key resolutions by finding ID, so all take the same conversion.
Snapshots main wrote at `36122eb2` prove the SQLite reopen and a second reopen at version 9.

## Regression proofs

The dismissal probe from #145's attack covers a head-2 reply whose record is lost before head 3.
The same-ID reopening regression proves a dismissal's thread is not reused.
The SQLite kill regression covers head 3's recorded resolution followed by a fresh finding at the same head.
An edit-accepted, resolve-failed regression proves the old thread closes even when the finding returns.
Status ordering, human resolution, reply deletion, author matching and paginated failures have separate tests.
