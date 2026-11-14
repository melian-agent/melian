# Melian's local store prunes only the cache it can rebuild, and keeps every changeset until the shared record holds it

Recorded by a builder agent on 2026-11-14 for [issue #348](https://github.com/melian-agent/melian/issues/348). The maintainer ruled on 2026-11-14, in the coordinator's session, that merged changesets wait for the shared record rather than being compacted. Everything else here is the builder's design, settled with the coordinator, whose answers are not rulings.

Amends: [2026-10-06-immutable-coverage-evidence.md](2026-10-06-immutable-coverage-evidence.md), for a content ID whose graph `melian store prune` removed.

Amends: [2026-10-06-graph-cache.md](2026-10-06-graph-cache.md), for expiry.

Amends: [2026-10-06-cache-scratch-recovery.md](2026-10-06-cache-scratch-recovery.md), for the scratch kinds the sweep recognises.

## Problem

Melian keeps one state directory per clone: `.git/melian/` by default, or `<MELIAN_STATE_DIR>/<clone hash>/`, as `CacheLocation.open` in `packages/pipeline/src/tool-provisioning.ts` resolves it. Nothing ever removes anything from it. On the coordinator's host on 2026-11-14 it held 15.7 GB of changeset files and 7.8 GB of cache, and it grows by about 0.4 GB a day on a disk with 28 GB free. A review round refuses to start when space runs low.

Some of the directory is cache and some is the only copy of a decision, and nothing said which. Example: `graphs/` holds an Enola graph for a git tree that no branch holds any more, and nothing will read it again. Beside it, a changeset file holds the only copy of a maintainer's dismissal and of the comparison data that [the shadow retirement rule](2026-10-06-shadow-retirement-merged-window.md) counts.

## What the store holds

| Part | What reads it | Rebuilt from | Today | Once the shared record holds the changeset |
| --- | --- | --- | --- | --- |
| A changeset file, `pull-*.sqlite` or `range-*.sqlite`, with its `-wal` and `-shm`: findings and dismissals, verdicts, rounds, the review index, comparisons and adjudications, publication records, the marker secret, task records and transcripts | `findings`, `dismiss`, `publish`, `compare`, `telemetry`, and a review that attaches or resumes | Nothing. This is the only copy | Durable | Cache, by rule 13 of [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md) |
| `graphs/<key>/`: an Enola graph, keyed by a git tree, Enola's version, its binary's digest and its policy | `static.enola` and caller context, for a review of that tree | Running Enola on a commit with that tree | Cache | Cache |
| `coverage/<graph key>/`: coverage artefacts and their indexes | `CoverageCache.read` for the same graph key, which treats a missing graph as a miss | The graph, and the lens transcripts | Cache | Cache |
| `mutation/<partition>/`: the last judged head's Stryker report for one review target | `static.mutation`, to run provisionally from an earlier head | A cold run | Cache | Cache |
| `tools/<name>/<version>/<platform>/<sha256>/`: a verified tool download | Static checks and `melian doctor` | A download, which GitHub can refuse, as it did on 2026-11-08 | Cache | Cache |
| `scripted/`: stores from `MELIAN_TEST_SCRIPT` runs on the fake model | `compare stats` and `backlog` in scripted mode | Nothing | Kept | Kept |
| Scratch: `.fetch-*`, `.graph-*`, `.prune-*`, `*.tmp` | Nothing | Not needed | Swept by `CacheScratch` | The same |

The coverage ledger is not built, so the store holds no ledger entries today, and nothing here deletes one. [Issue #307](https://github.com/melian-agent/melian/issues/307) keeps its retention.

## Decision

### 1. A part is cache or durable by its kind, and anything else is kept

The table is the rule. `melian store prune` removes only the cache kinds it names. It never removes a changeset file or its `-wal` or `-shm`, anything under `scripted/`, or a name it does not recognise, and it reports what it left. A part a later build adds is kept until a decision names it.

### 2. `melian store prune` removes rebuildable cache

- `melian store prune` prints what it would remove, each kind's count and the space that frees, and removes nothing. `melian store prune --apply` removes it and prints the same. A mistyped command removes nothing.
- It finds the directory through `CacheLocation.open`, so it follows `MELIAN_STATE_DIR`, and wherever [issue #424](https://github.com/melian-agent/melian/issues/424) moves the store.
- A graph goes when its `entry.json` says it was created more than seven days ago and its tree is not the tree of a live commit, with its coverage directory. A live commit is the tip of a local branch or a remote-tracking ref, or the `HEAD` of any registered worktree; git answers through `git for-each-ref`, `git worktree list --porcelain` and `^{tree}`. A worktree's `HEAD` counts because the coordinator runs rounds from detached worktrees, whose trees no ref names. Refs under `refs/melian/pull/` don't count, because they outlive a merge; the seven days spare a fork head reviewed this week.
- A graph directory with no readable `entry.json` goes once its modification time is more than a day old, since every reader treats it as a miss.
- A coverage directory whose graph is gone goes, since `CoverageCache.read` can never return it.
- A mutation partition goes when nothing in it was written for more than 14 days. The next run of that target starts cold.
- Every tool entry stays, pinned or not, until it meets [the tool-cache decision](2026-10-06-tool-cache-publication.md)'s condition for pruning: that a prune account for executable paths in use, which this one does not.

The rule spares about 1.5 GB of graphs on the host, those whose trees are still the tips of merged branches nobody deleted. Deleting the branch frees them on the next prune; the rule is not widened to chase them.

A merge base counts as no live commit. Enola builds a graph for the base of every static run, and the next review of that base rebuilds it.

### 3. A prune beside a live review

A static run registers its worktrees with `git worktree add --lock --reason "melian-static pid <pid>"` before it reads the cache. When any registered worktree carries that lock and its process is alive, prune removes nothing, names the run, and exits non-zero. It reads the worktree list again before each removal, so a run that starts during a prune stops it.

What remains is a run that registers in the moment between that read and a removal. Each removal renames the entry to a `.prune-<pid>-` name in its own directory, then deletes it, and `CacheScratch` sweeps a dead pruner's leftovers as it sweeps a dead fetch's. A reader that loses the race fails closed: `static.enola` fails its coverage store on a graph that has gone, the review reads not reviewed, and a rerun rebuilds the graph.

`apply` decides once. Before each removal it reads again only the static-run locks and a mutation partition's age; it does not read refs or graph entries again. Codex's adversarial review on [pull request #426](https://github.com/melian-agent/melian/pull/426) named three races this leaves, and each costs a rebuild:

- A tree that becomes live during the prune, such as a branch created at an old commit, loses its graph, and its next review rebuilds it.
- A static run that starts and finishes inside one removal loses the graph or coverage it just wrote, and the next run rebuilds it.
- A graph that a run repairs during the prune is removed, and rebuilt.

A folder can change under the plan too. Codex's second review on the pull request found that `apply` keeps only relative paths, so a `coverage/` swapped for a link after the plan carried the rename, and the removal, to wherever the link pointed. Prune now checks for a link immediately before each rename: when the state directory or the path's folder is a link, it skips that path, and it leaves the path's entry out of what it reports removed, so the count and the space freed never include it.

A state directory that is already a link when prune plans is refused, with an error that names the path and says how to move the store into a folder. `apply` skips every path through a linked state directory, so a plan through one listed entries that `--apply` then left alone while it reported success. The review of record on the pull request found it. Prune does not resolve the link instead, since it never follows one.

A swap between that check and the rename is not prevented. Node offers no removal relative to an open directory handle, so no check in plain Node closes the window, and each one added only narrows it. The swap needs write access to the state directory, or to a directory above it whose link the state directory's path follows. Repointing such a link after the plan redirects the whole removal, since prune names the state directory by the path it was given, as every other Melian command does. The worst outcome is this: the rename and the recursive delete follow the link out of the state directory, and remove a directory there with the same name as the planned entry. That is the one outcome of this command that does not cost only a rebuild. Someone with that write access can already delete or corrupt the store directly, and someone who controls a link above it already decides where every Melian command reads and writes the store, its changeset files included. The coordinator accepted the window on that ground, as an answer on approach and not a new ruling, by the precedent of [pull request #399](https://github.com/melian-agent/melian/pull/399): the maintainer, on 2026-11-14 in the coordinator's session, accepted the same kind of window in the shared record's folder store, where a trusted writer swaps a folder for a link between Melian's check and its write.

Reading every entry again would narrow these windows, not close them, and this decision adds no lock. They are acceptable for one reason: what prune chooses to remove is only what Melian can rebuild. The link window above is the one exception, reachable only by someone with write access to the state directory or a directory above it. If a later change lets prune remove anything durable, these races stop being acceptable, and that change needs its own exclusion first. A comment beside `apply` says so.

A lens round reads the head's graph with no lock held, since the static checks have finished by then. Prune can take that graph only when it was built more than seven days ago and no branch, remote-tracking ref or worktree `HEAD` holds its tree, as when a pull request's head sits only under `refs/melian/pull/`. This case does not fail closed. The graph tool reads the graph on its first call and keeps it in memory, so a removal after that call changes nothing. A removal before it makes the tool tell the lens to use search and `read_file` instead. The lens carries on, its record reads `ran`, and the verdict stands, as it does for any unreadable graph today. The next review rebuilds the graph, because every review builds its caller context afresh. No lock is added for this: a missed graph costs the lens search time, not a wrong verdict.

### 4. What prune changes in the coverage and graph-cache decisions

[The immutable-coverage decision](2026-10-06-immutable-coverage-evidence.md) says an explicit content-ID lookup reads historical evidence. Prune removes a graph's coverage with it, so a lookup by a content ID under a removed graph is a miss. `CoverageCache.read` returns nothing: never an error, and never another artefact, even after the graph is rebuilt under the same key. A caller treats the miss as it treats any coverage it cannot read: the evidence is gone, and a review that needs it builds it again. A check record that names the ID keeps it. No production code reads coverage by content ID today. `grep -rnE "\.read\([^)]*\{ *id" packages/*/src` finds nothing, and the only readers, in `enola-static.ts` and `callers.ts`, read the producer's current index.

[The graph-cache decision](2026-10-06-graph-cache.md) says no timestamp expires an entry. `melian store prune` may remove a graph more than seven days old whose tree no branch, remote-tracking ref or worktree `HEAD` holds, and nothing else removes one. Nothing expires on its own: an entry stays until someone runs `melian store prune --apply`.

[The cache scratch recovery decision](2026-10-06-cache-scratch-recovery.md) names fetch, graph and coverage scratch. Prune's `.prune-<pid>-` scratch joins them, swept on the same rule: removed once its process is gone, and after a day when no process is named. This extends the list and changes nothing a user sees. The coordinator settled it as a choice of approach; the two amendments above wait on the maintainer.

### 5. Merged changesets wait for the shared record

Compaction lost. The proposal was to copy a merged pull request's changeset into a fresh store holding every record at its current value and no transcripts. On the host's figures for 2026-11-14 that frees little: transcripts are 3.0 GB of the 15.7 GB, while document revisions are 7.8 GB and task records 4.2 GB, and a copy keeps both. It also needed a spike to show Pi Durable opens a store whose tasks name entries it no longer holds, and a copy-and-verify path in durability code that the shared record replaces. Meanwhile 10.3 GB of range changesets are more than 14 days old and nothing has written them in two days, so the space waits in files the shared record will make cache. The maintainer chose to wait for it.

Once a changeset's records are in the shared store, by its rule 13 the local file is cache. A merged pull request's file is then deleted whole, once a fresh `list` from the store shows its records. That is a later build, not this one.

## What this gives up

- An old tree reviewed again reruns Enola, and an old mutation target runs cold.
- The changeset files keep growing until the shared record lands. On the host's figures, prune frees about 4.3 GB of graphs and their coverage, plus whatever mutation partitions and orphan coverage have aged out: ten days or more of growth.
