# The git record store refuses a stray file by where it sits

Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 12's refusal of a branch that holds a file Melian did not write, and where the git adapter builds its commits

The maintainer ruled on 2026-11-14, in the coordinator's session, on [issue #393](https://github.com/melian-agent/melian/issues/393): a stray file is refused by where it sits ("4. A"). He agreed on 2026-11-14, in the coordinator's session, that the adapter keeps its own repository rather than the clone's object database. The wording below, of what "known" means, of the two scopes and of what the refusal still promises, is the builder's and the coordinator's, not his.

## The problem

Rule 12 says a branch holding any file Melian did not write is refused whole. The record store's conformance suite, which merged with [pull request #399](https://github.com/melian-agent/melian/pull/399), says otherwise: a stray file planted among one changeset's records stops work on that changeset, and another changeset's `add` and `list` still succeed. The directory store already behaves so. One adapter cannot meet both.

Refusing the whole branch would let one bad file halt every review on the repository until a writer removed it. Refusing by location keeps that cost to the changeset the file sits in, wherever the file says which changeset it belongs to.

## Decision

### What "known" means

An entry of the branch's tree is known when it is a regular file, git mode `100644`, at one of two kinds of path:

- `changesets/<changeset>/cell.json`, where `<changeset>` is a name the store accepts.
- The path a record's own bytes give, `changesets/<changeset>/<kind>/<hash of key>/<id>.json`: its bytes are a record envelope in canonical form whose ID is the file's name, and the path the envelope gives is the entry's path.

Every other entry is unknown: another name, another mode, a symbolic link, a submodule, or a file at a record's path whose bytes give another path or another ID.

### Two scopes

An unknown entry under `changesets/<A>/`, where `A` is a name the store accepts, refuses every call on `A`: `list`, `add`, `readCell`, `writeCell` and `dispose`. Calls on any other changeset go on. Examples: `changesets/A/notes.txt`; a symbolic link at `changesets/A/cell.json`; `changesets/A/finding/<hash>/<id>.json` whose bytes hash to another ID.

Any other unknown entry refuses every call on every changeset. Examples: an `index.json` at the root; `changesets/Bad Name!/x.json`, under a directory no changeset could be named; `changesets` itself as a file rather than a folder.

Each refusal is a `RecordError` with the code `unknownFile` that names the entry, and `melian doctor` names every unknown entry for a writer to remove.

### What the refusal still promises

Melian judges every entry of the tree it fetched before it answers a call or builds a commit, so a refused call returns no record, not even the known ones beside the stray, and pushes nothing. That is what "before a byte is read in part or pushed over" now means: no call answers from a tree it has judged in part, and no push replaces a tree it has not judged whole.

An unknown entry's bytes are read only to judge it, and only where it sits at a record's path; they never reach a caller. A call on another changeset carries the entry along unchanged by its object ID, as git carries any tree entry a commit does not touch. Melian never rewrites or removes it. That is the cost of the ruling: a stray entry stays on the branch, inside every commit another changeset's writes push, until a writer removes it.

### Where commits are built

Melian keeps a bare repository of its own at `records.git` in the clone's state directory, and fetches `melian/state` into it from the URL of the clone's `origin`. Rule 12's commits are built there, with git's plumbing, instead of in the clone's object database. The clone's hooks, configuration and refs stay the user's, and a fetch writes nothing into them.

Melian writes that repository's configuration when it creates it, and checks the bytes before every command; a repository whose configuration has changed is refused, with the advice to delete `records.git`. Every command also passes the settings that would run a program, sign or pack in the background, such as `core.hooksPath` and `push.gpgSign`, on its command line.

## What this gives up

- A stray entry inside one changeset's folder is carried in every later commit until a writer removes it.
- The adapter's repository is a second copy of the branch on disk. It keeps every object it has fetched, so it grows with the branch's history. The maintainer accepted that on 2026-11-15, until [issue #451](https://github.com/melian-agent/melian/issues/451) collects old objects.
- A call holds the whole tip in memory. A tip whose records and cells total more than 256 MiB, or that holds more than 65,536 entries, fails every call as `unreachable` until writers dispose of changesets. The byte limit is provisional, on the coordinator's answer of 2026-11-15; [issue #455](https://github.com/melian-agent/melian/issues/455) designs a read that does not hold the whole tip.

## What one call uses, and what bounds it

The maintainer ruled on 2026-11-15, in the coordinator's session, that the entry limit is built now, that a handle's cache of judged entries waits for [issue #455](https://github.com/melian-agent/melian/issues/455), and that what a killed process leaves behind waits for [issue #460](https://github.com/melian-agent/melian/issues/460). The table lists every resource a call takes, and what bounds it or who accepted it unbounded.

| Resource | What bounds it, or who accepted it | Test or issue |
| --- | --- | --- |
| Memory for records and cells | 256 MiB of readable blobs at the tip, `tipLimit`, from the sizes git reports, a blob counted at every path it sits at, and the read stops at those sizes. The limit counts bytes, not the heap, which holds each blob several times over, as bytes, text and parsed objects | `store.test.ts`, "the bytes a tip may hold"; [issue #455](https://github.com/melian-agent/melian/issues/455) |
| Memory for the entries | 65,536 entries, `entryLimit`, checked before any size is read | `store.test.ts`, "the entries a tip may hold" |
| Memory for the listing of entries | 64 MiB, `listingLimit`, a KiB a line on average; git is stopped there, so the list never grows past it | `store.test.ts`, at the cap and one byte past it |
| A tip past either limit | No write of Melian's makes one: a write measures its commit by both limits before it pushes, and again after it rebuilds on a moved tip, and fails as `unreachable`, pushing nothing, when the commit would pass one. Dispose only shrinks the tip, so it works at either limit. A tip past a limit by another route still fails every call, dispose included. A writer on an older build or a push by hand can make one. A writer clears it by hand, removing files such as a changeset's folder in a commit of their own | `store.test.ts`, "the entries a write may leave" and "the bytes a tip may hold" |
| Memory for the sizes | One line per distinct readable blob, so the entry limit bounds it | the entry limit's tests |
| Memory for git's other output | Not bounded: core's `git` keeps a command's stderr whole, and a fetch's or push's stderr carries what the remote sends | none; it is core's, and holds for every caller of `git` |
| A handle's cache of judged entries | Not bounded across calls. Accepted by the maintainer on 2026-11-15 until [issue #455](https://github.com/melian-agent/melian/issues/455): no process holds a handle open across many tips yet | [issue #455](https://github.com/melian-agent/melian/issues/455) |
| Disk in `records.git` | Not bounded: it keeps every object it fetched. Accepted by the maintainer on 2026-11-15 until [issue #451](https://github.com/melian-agent/melian/issues/451) | [issue #451](https://github.com/melian-agent/melian/issues/451) |
| The temporary index, the half-made repository folder and the fetch ref, on a call that returns or throws | Removed before the call returns. The fetch ref is deleted as soon as the fetched tip is read, before the hint is updated, and also when that read fails. One case is left: a call whose deadline runs out between the fetch and the deletion, since no git command starts once none is left | `repository.test.ts`, "leaves no index behind", "retries deleting its ref …, and leaves no ref", "deletes its ref when reading the fetched tip fails" and "deletes its ref before it points the hint at the tip …"; `create.test.ts`, "fails as unreachable, keeping the cause, when the rename fails" |
| The same, left by a process killed mid-call, and a fetch ref left by a call whose deadline ran out before it could delete the ref | Not removed. The maintainer accepted the leftovers of a killed process on 2026-11-15 until [issue #460](https://github.com/melian-agent/melian/issues/460), which sweeps them when the store opens. A fetch ref left at the deadline pins the same objects and has the same cure, so the coordinator read it on 2026-11-15 as the same leftover; that reading is the coordinator's, not a ruling. A leftover is provably stale only when no live call can own it: its name must record its owner, a pid with that process's start time, so a sweep removes only those whose process has gone. An age alone proves nothing until the store caps the deadline a caller may set | [issue #460](https://github.com/melian-agent/melian/issues/460) |
| The records on the branch, when a writer deletes it | Not protected yet. A deleted branch reads as empty, and the next write creates it afresh holding that write alone, and reports success: the earlier records and disposal marks are gone, so a disposed changeset can be written again. A host cannot tell a deleted branch from a store never made, since a fresh handle has seen neither, so no check in the store closes it. [Issue #463](https://github.com/melian-agent/melian/issues/463) will protect the branch with a ruleset forbidding deletion and force pushes. The maintainer agreed on 2026-11-15 to add it when real records first go onto the branch. Until then, rule 6 of [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md) accepts it: write access to the store is the trust, and a writer who can rewind the store can drop its later records. The coordinator answered so on 2026-11-15, from that rule | `writes.test.ts`, "counts as lost when the branch it was built on is gone, and pushes again"; [issue #463](https://github.com/melian-agent/melian/issues/463) |
| Time | One deadline for the whole call, two minutes unless given; no git command starts once none is left | `deadline.test.ts` |
| Child processes | One git at a time, stopped at the deadline. A transport git started, such as ssh, can outlive it, by core's design; it ends on its own | `deadline.test.ts` |
| Refs | One fetch ref per call, deleted before it returns but for the deadline case above, and `refs/melian/last` | `repository.test.ts`, "retries deleting its ref …, and leaves no ref" |
| Retries | A lost race retries until the deadline; deleting a ref and updating the hint each give up after twenty tries | `writes.test.ts`, the lost-race tests; `repository.test.ts`, "fails as unreachable once a lock outlasts its retries" |
