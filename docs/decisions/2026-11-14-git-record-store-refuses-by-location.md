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
- The adapter's repository is a second copy of the branch's tip on disk. It holds one fetch of the tip, not the branch's history.
