# The shared record branch retires the records of finished pull requests

Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 13's keeping of the live record: the tip keeps open and recent pull requests' records, and a scheduled job retires the rest
Amends: [the git record store decision](2026-11-14-git-record-store-refuses-by-location.md), what a tip past a limit refuses: a retirement is the one call that still works there
Amends: [the git record store decision](2026-11-14-git-record-store-refuses-by-location.md#what-one-call-uses-and-what-bounds-it), its table of what one call uses: the rows a retirement adds

The maintainer ruled on 2026-11-21, in the coordinator's session, on [issue #617](https://github.com/melian-agent/melian/issues/617). The tip keeps the records of open pull requests and of pull requests merged in the last 30 days ([comment](https://github.com/melian-agent/melian/issues/617#issuecomment-7040616681)). A scheduled job that runs no pull request's code removes older ones. A warning shows when the store passes half of any of its three limits: entries, record bytes and listing bytes. He agreed, on the same day and in the same session, to the plan's three further points ([comment](https://github.com/melian-agent/melian/issues/617#issuecomment-7052775102)):

- A pull request closed without merging keeps its records for 30 days from `closed_at`.
- A reader asked about records that have left the tip answers "archived" and names the commit that removed them.
- Removal by age amends rule 13.

He agreed on 2026-11-22, in the coordinator's session, to two more ([comment](https://github.com/melian-agent/melian/pull/639#issuecomment-7071348428)). A retirement keeps any changeset folder that is disposed or holds a cell, and reports it as kept; rule 3 of the shared record decision stands as written. He also agreed to the warning's wording above.

The removal-only rule, the tree-ID check and the operation's name are the builder's, from [the plan](https://github.com/melian-agent/melian/issues/617#issuecomment-7049657837) and [its addendum](https://github.com/melian-agent/melian/issues/617#issuecomment-7049676449), which the coordinator read.

## The problem

Every round on the default branch relays about 26 records to `melian/state`, and nothing removes one. The tip may hold 65,536 entries and 256 MiB of records. At about 270 rounds a week, the entry limit is about nine weeks away. Past a limit every call fails, and only git by hand brings the tip back under. Once [the gate](https://github.com/melian-agent/melian/issues/395) reads the store, that stops every merge.

Rule 13 kept the live record on purpose: "the live record is small enough to keep". That no longer holds.

`dispose` cannot serve. It leaves a `{"disposed":true}` cell for good, so a reopened pull request's next relay would fail with `disposed`, which is what rule 13 forbids. The mark also costs an entry for ever.

## Decision

### What the tip keeps

The tip keeps the records of every open pull request. It also keeps those of a pull request merged in the last 30 days, or closed without merging in the last 30 days, counted from `merged_at` or `closed_at`. Every other pull request's changeset is retired. Its records stay in the branch's history.

Closing a pull request still disposes nothing, and `dispose` keeps its meaning: a writer's own command removes a changeset for good and marks it.

### Retirement

`GitRecordStore.retire(seen)` takes changeset names, each with the tree ID its folder had when the caller decided. In one commit it removes each folder that holds records alone, with no mark. A retired changeset is the same as one never written, so a reopened pull request records again from nothing.

A folder that holds a cell is kept, and reported as kept. A cell holds a lease or a disposal mark. Rule 3 of the shared record decision never recreates a changeset, since that would need an incarnation every record and writer carries, and removing a cell would recreate it. Today no production code writes a cell or disposes, so this keeps nothing yet. [Issue #641](https://github.com/melian-agent/melian/issues/641) designs the mark that would carry a lease and a disposal across a retirement, and blocks the work that first writes either to the shared store.

A folder is also kept, and reported, when any of these hold:

- Its tree ID at the fresh tip differs from the one the caller saw. A round wrote to it since, so the caller judges it again next time.
- It holds a stray. No call removes a stray.
- It is too large to judge whole. Such a folder counts as holding a stray.
- `changesets/` lists its name twice. git writes such a tree, and a remote that runs no fsck takes it. Only one copy could be judged, and removing the name removes both, so neither is a folder.

A retirement judges folders in the order it was given them, and keeps a running total of the entries and readable bytes it has judged. A folder that would take that total past the entry limit or the byte limit is kept unjudged, and so is every folder after it. All of them are reported as deferred, for the next run to retire. So a tip far past the byte limit sheds what one call may hold, and the next run takes the rest.

Every lost race fetches the tip and decides again. So a round's `add` that lands first keeps its folder, and an `add` after a retirement starts the folder afresh.

That has one limit. A retired folder leaves no mark, so nothing refuses a stale host that relays the changeset's ordinary records after the retirement, such as a re-run of an old round's records job. It writes the folder again with those records, and they stay on the tip until the next run retires them. If the pull request has reopened in the meantime, they join its new records. Ordinary records carry no lease, so this touches no publication slot.

### The removal-only rule

A retirement pushes only a commit that passes this rule:

- The commit's one parent is the tip it was built on.
- Every root entry but `changesets` is the parent's, by name, mode, type and object ID.
- `changesets` is still a tree, or is gone because every folder went.
- Each entry left in `changesets` is one of the parent's, by name, mode, type and object ID.
- Each entry gone from `changesets` is a tree that bears a changeset's name, and the parent's `changesets` lists no name twice.
- At least one entry is gone.

A commit that passes is pushed whatever the tip's totals. A retirement reads only the top level of `changesets/` and the folders it was asked to retire, so it works on a tip past any limit, and it is the one call that does. A commit that fails is refused as `unreachable`, and nothing is pushed. Every other write keeps its limit checks.

#### What a retirement holds

| Resource | What bounds it | Test |
| --- | --- | --- |
| Memory for the folders' entries | 65,536 entries, `entryLimit`, across every folder one call judges, and per folder before its sizes are read | `retire.test.ts`, "judges folders that together list exactly the entry limit, and defers the one that passes it" |
| Memory for the folders' records | 256 MiB of readable blobs, `tipLimit`, across every folder one call judges, from the sizes git reports, before any blob is read | `retire.test.ts`, "judges folders whose records together total exactly the byte limit …" and "on a tip far past the byte limit, retires what fits and defers the rest without reading their records" |
| Memory for the top level of `changesets/` | 64 MiB, `listingLimit`, as for any listing | `retire.test.ts`, "refuses a tip whose top level lists past its bytes" |
| Judgements of a retirement's folders | Held for the call alone and dropped when it returns; none goes into the handle's cache | `retire.test.ts`, "keeps no judgement past the call, so a read after it reads the folder's records again" |

## Who retires, and when

A scheduled workflow on the default branch retires. It runs no pull request's code. It learns which pull requests are open and when each merged or closed from GitHub's API, never from a record. [Issue #617](https://github.com/melian-agent/melian/issues/617) builds it in a later pull request.

## What it costs

A retired pull request's records can be read only from history, and no command reads them there yet. [Issue #630](https://github.com/melian-agent/melian/issues/630) designs that beside [issue #361](https://github.com/melian-agent/melian/issues/361)'s bound on history.
