# Publication retires resolutions when a thread is reused

Status: accepted after the attacking review, implementation in this change.

This extends publication recovery without replacing signed markers, target checks, dismissal rules or status mapping.
It addresses [issue #132](https://github.com/melian-agent/melian/issues/132) in [pull request #145](https://github.com/melian-agent/melian/pull/145).

## Problem

A reply may reach GitHub before a crash loses its checkpoint.
An old resolution may remain owed after a finding returns to its thread.
For example, H1 posts F in T, H2 plans its resolution, and H3 records that resolution before crashing.
A new review of H3 reports F again.
Reusing T without retiring that instruction lets the closing pass resolve a live finding's thread.

## Decision

Write the current verdict's status before reading any thread or publication marker, including recovery of an older pending round.
A failed thread read must never leave an older success standing on the same head after its base changes.
Step 28's mapping, dismissal attestations and version-9 findings lifecycle stay unchanged.
Publication calls no model.

Keep the existing provider port and widen `findPublished`'s answer markers to every head.
Review and finding-root recovery still match the requested head; answers are keyed by finding, actual root comment and dismissal version.
An answer counts when either the durable journal or GitHub records it.
A deleted reply is not repeated when its journal entry survives.
An addressed edit counts only on its own signed finding root.
A reply counts only when its author matches its signed root's author, even when an installation token cannot read `/user`.
Signature verification remains mandatory, and a known token author remains an additional filter.

Read GraphQL thread state lazily, when publication will reuse, answer or resolve that thread.
Cache complete reads within one attempt and reset them on replay.
A still-open finding requires no thread read and is never reposted merely because a human resolved its thread.
It continues to count in the status and appears in the next review body.
A returning finding cannot reuse a human-resolved thread.
Answers still owed to a human-resolved thread are posted; resolving it again is a no-op.
A known root absent from GraphQL but present in REST is not gone.
Its resolved state is unknown, so publication waits for GraphQL before reusing or resolving it.

Reuse requires an undismissed returning finding, no answer in either source and an open thread.
In the commit assigning a thread to the live plan, retire every outstanding resolution against that thread across all heads, including this head.
Keep the reply journal and review attestations.
Recover a pending review's immutable payload as before, then plan the current verdict before executing thread actions.
Only the resolutions remaining after those assignments may execute.
No ownership document is needed. The as-built section records the resolution-map upgrade.

An addressed edit and thread resolution are separate effects.
If the edit landed but resolution did not, resolve that old thread on the next publish, whether or not its finding is live.
A returning finding gets a new thread; the old thread's resolution depends on its assignment, not the finding ID.
A reopened dismissal also gets a new thread, even when the old dismissal reply is still owed.
Dismissal replies keep their existing behaviour: they do not resolve threads.

## Complete reads and cost

Bound each review, comment and GraphQL thread listing at 50 pages of at most 100 entries.
Fail on a failed page, GraphQL errors, partial or malformed data, a missing next cursor, or a repeated cursor.
Fetch all pages before using any results; never substitute stored flags for a failed read.
The status is already current; subsequent thread, review and ledger work waits for a successful attempt.
A root deleted between read and write still takes the existing 404 recovery.
GitHub offers no atomic read-and-write transaction, so these reads cannot serialise human edits after the read.

Reuse the cross-head answer listing for planning and closing, replacing per-entry, per-head probes.
A normal new round already lists reviews and comments; widening their interpretation adds no REST call.
GraphQL adds its paginated read only when there is a thread action, as resolution discovery did before.
Reuse and dismissal-only attempts may therefore add that read.
A settled rerun with nothing owed lists no publication markers and reads no threads.
No unconditional snapshot preflight or new snapshot API is introduced.

## Regression proofs

The dismissal probe from the attack covers an H2 reply whose record is lost before H3.
The same-ID reopening regression proves a dismissal's thread is not reused.
The SQLite kill regression covers H3's recorded resolution followed by a fresh finding at the same head.
An edit-accepted, resolve-failed regression proves the old thread closes even when the finding returns.
Status ordering, human resolution, reply deletion, author fallback and paginated failures have separate tests.

## As built: several owed threads per finding

Pass 4 found that the owed-work fold still kept one resolution per finding ID.
An older addressed thread could fail to resolve until a newer thread for that finding resolved.
Carrying only the newer thread then lost the older instruction.

Published-document version 8 keys resolutions by finding, actual root comment and dismissal version, using `replyKey`.
Each entry keeps its finding ID. Body-only resolutions retain the finding ID as their key.
Planning, pending rounds and closing preserve every owed thread.
Current resolutions run before carried work, so one failed older thread cannot hide a newer thread's resolution.
The migration rekeys both recorded and pending resolutions and leaves the pending review payload intact.
A version-7 fixture written through that version's publisher proves SQLite reopening and a second version-8 reopen.
