# Melian's local store prunes only what it can rebuild, and compacts a merged pull request's changeset to what is still read

Status: draft for the maintainer's ruling, written by a builder agent on 2026-11-14 for [issue #348](https://github.com/melian-agent/melian/issues/348). Nothing here is ruled. Once it is, this file records the ruling, and [design.md](../design.md) and the [implementation plan](../design-implementation-plan.md) change in the same pull request.

## Problem

Melian keeps one state directory per clone: `.git/melian/` by default, or `<MELIAN_STATE_DIR>/<clone hash>/`, as `CacheLocation.open` in `packages/pipeline/src/tool-provisioning.ts` resolves it. Nothing ever removes anything from it. On the coordinator's host it held 21 GB on 2026-11-08 and about 22 GB on 2026-11-14, and it grows by about 1 GB a day. That disk has 22 GB free, and a review round refuses to start when space runs low, so the host stops reviewing in about two weeks.

Some of the directory is cache and some is the only copy of a decision, and nothing says which. Example: `graphs/` holds an Enola graph for a git tree that no branch holds any more, and nothing will read it again. Beside it, a changeset file holds the only copy of a maintainer's dismissal and of the comparison data that [the shadow retirement rule](2026-10-06-shadow-retirement-merged-window.md) counts.

[The shared record decision](2026-11-13-shared-record-behind-a-store-port.md) changes the answer, but not yet. Its rule 13 says that once a changeset's records are in the shared store, everything local is cache. Its first build is landing now, and builds 2 to 6 follow. So this decision says what is safe to remove today, before the shared record exists, and what becomes removable after.

## What the store holds

| Part | What reads it | Rebuilt from | Today | Once the shared record holds the changeset |
| --- | --- | --- | --- | --- |
| A changeset's record documents, in `pull-*.sqlite` or `range-*.sqlite`: findings with their dismissals and history, verdicts, rounds and their frozen verdict copies, the review index, provenance, comparisons and adjudications, publication records, the publisher's marker secret, membership snapshots, walkthroughs and run snapshots | `findings`, `dismiss`, `publish`, `compare` and its `stats`, `backlog`, `export` and `refresh`, `telemetry` | Nothing. This is the only copy | Durable | Cache, by rule 13 |
| A changeset's task records: adjudication, publication, lens, check, verification, triage and walkthrough tasks | Adjudication records: `compare`, `publish` and `findings`, to tell a decided verdict. Publication inputs: `compare refresh` and `telemetry`. The rest: a review that attaches, resumes or reruns | Nothing | Durable | Cache |
| A changeset's transcripts, the entries of its lens, verifier, triage and walkthrough conversations | A running or resumed review, `--rerun`, and `telemetry`'s spans. No verdict, dismissal or comparison reads one after its round is decided | Nothing | Working state, by rule 1 of the shared record decision, kept because Pi Durable cannot drop it in place | Cache |
| `graphs/<key>/`: an Enola graph, keyed by a git tree, Enola's version, its binary's digest and its policy | `static.enola` and caller context, for a review of that tree | Running Enola on a commit with that tree | Cache | Cache |
| `coverage/<graph key>/`: graph, review and test coverage artefacts and their indexes | `CoverageCache.read` for the same graph key, which treats a missing graph as a miss. A check record stores the artefacts' IDs, but no code reads them back | The graph, and the lens transcripts for review coverage | Cache | Cache |
| `mutation/<partition>/`: the last judged head's Stryker report for one review target | `static.mutation`, to run provisionally from an earlier head | A cold run, which is the run that may pass anyway | Cache | Cache |
| `tools/<name>/<version>/<platform>/<sha256>/`: a verified tool download | Static checks and `melian doctor` | A download, which GitHub can refuse, as it did on 2026-11-08 | Cache | Cache |
| `scripted/`: stores that `MELIAN_TEST_SCRIPT` runs wrote on the fake model | `compare stats` and `backlog` in scripted mode only. `publish` refuses them | Nothing, but nothing in them reviewed real code with a real model | Not decided here; see question 5 | The same |
| Scratch: `.fetch-*`, `.graph-*`, `*.tmp` | Nothing | Not needed | `CacheScratch` already sweeps it on every cache open | The same |

The coverage ledger, `melian.coverage`, is not built, so the store holds no ledger entries today. [Issue #307](https://github.com/melian-agent/melian/issues/307) keeps its retention, and nothing here deletes a ledger entry.

## Decision

### 1. A part is cache or durable by its kind, and anything else is kept

The table above is the rule. `melian store prune` removes only the cache kinds it names, and leaves and reports anything it does not recognise. So a part a later build adds is kept until a decision names it.

### 2. Step one: prune the cache, now

This needs no ruling beyond "cache that can be rebuilt", and can ship as its own pull request.

- `melian store prune` prints what it would remove, each kind's count and the space that frees, and removes nothing. `melian store prune --apply` removes it and prints the same.
- It finds the directory through `CacheLocation.open`, so it follows `MELIAN_STATE_DIR`, and wherever [issue #424](https://github.com/melian-agent/melian/issues/424) moves the store.
- A graph is removed when its `entry.json` says it was created more than seven days ago and its tree is not the tree of any local branch or remote-tracking ref. Git answers which trees those refs hold, through `git for-each-ref` and `^{tree}`. The refs under `refs/melian/pull/` don't count, because they outlive a merge. Its coverage directory goes with it. The ref check spares the graph of an open pull request's head, which a fetch keeps under `refs/remotes/origin/`. The age spares a graph a review wrote this week for a tree that no ref holds.
- A graph directory with no readable `entry.json` is removed once its modification time is a day old, since every reader already treats it as a miss.
- A coverage directory whose graph directory is gone is removed, since `CoverageCache.read` can never return it.
- A mutation partition whose `partition.json` was last written more than 14 days ago is removed. The next run of that target starts cold, which is the run that may pass.
- A tool entry whose name, version, platform and digest the bundled manifest does not pin is removed. Every pinned entry stays, whatever its age, because a download can fail.
- It never removes a `.sqlite` file, its `-wal` or `-shm` file, anything under `scripted/`, or a name it does not recognise.
- It may run beside a review. Each removal first renames the entry to a `.prune-<pid>-` name in the same directory, then deletes it, and `CacheScratch` sweeps a dead pruner's leftovers as it sweeps a dead fetch's. A reader that loses the race sees a miss and rebuilds. The one race that costs anything is a review reading a graph more than seven days old whose tree no ref holds: its coverage store fails, and caller context records coverage as unavailable, which is advisory.

On the coordinator's host the 2026-11-08 figures put this at about 3 GB of graphs and up to 3 GB of coverage. That is about six days of growth, so step one buys time and does not stop the growth.

### 3. Step two: compact a merged pull request's changeset

The growth is in the changeset files, and most of a changeset file is transcripts. The shared record decision measured 56 MB of record documents across 67 pull-request stores that held 4,226 MB in all, every document revision included. The figures asked for below should confirm the split.

Pi Durable is the authority on what a changeset may drop, and it can drop nothing in place: its `Storage` port has no way to delete an entry, a conversation or a task, and only retires a document. Deleting rows with SQL and vacuuming would break invariants Pi owns, such as entries being immutable, so this decision rejects it.

The proposal is to copy forward:

- A changeset qualifies when it reviewed a pull request that GitHub reports merged more than 14 days ago, or a range whose head is an ancestor of `origin/main`, by `git merge-base --is-ancestor`, and whose file nothing has written for 14 days. A pull request closed without merging never qualifies, since it can be reopened.
- Compaction opens a fresh SQLite file through Pi's storage and commits into it every conversation record, every task record, and every document at its current value. It copies no entries and no submissions.
- It then reopens the new file with the current build and checks that the findings, dismissals, verdicts, rounds, comparisons and membership snapshots read back equal to the old file's. Only then does it replace the old file. Any difference keeps the old file and names the difference.
- The new file holds a Melian document saying it was compacted, when, and what it dropped. `review`, `--rerun`, `dismiss` and `publish` refuse a compacted changeset with that reason. `findings`, `compare` and its subcommands, and `telemetry` read it.

What is kept: every finding and its dismissals, every verdict and round, the review index and provenance, every comparison and adjudication, the publication records and the marker secret, membership snapshots, walkthroughs, run snapshots, Pi's usage documents, and every task's record.

What is lost: the transcripts, so nobody can read what a lens read or wrote, and `telemetry` loses the spans it reads from them. Document history before the current value goes too, which only a fork of the root conversation reads, and a merged pull request is never forked. The changeset can never be reviewed again. A merged pull request takes no new pushes, so that costs nothing in practice.

A spike comes before the build, because this rests on something unproven: that Pi Durable opens a store whose tasks and submissions name entries it no longer holds, and that every Melian reader works over it. [Issue #372](https://github.com/melian-agent/melian/issues/372) seeded a fresh store from records through Pi's public surface, which is close to this but not the same.

### 4. Once the shared record holds a changeset

By rule 13, the whole local file is cache once the changeset's records are in the shared store. A merged pull request's file can then be deleted whole, once a fresh `list` from the store shows its records. Step two's compaction is a stopgap until then, and is retired once that build lands.

## What this gives up

- An old tree reviewed again reruns Enola.
- A compacted pull request keeps no transcripts and no detailed telemetry.
- Step two adds a copy-and-verify path to durability code that the shared record later replaces.

## Questions for the maintainer

1. Should `melian store prune` change nothing unless given `--apply`? Recommended: yes, so a mistyped command removes nothing.
2. Is a seven-day age, with branch and remote-tracking trees spared, the right rule for graphs? Recommended: yes. On 2026-11-08, 2,565 of 3,249 graphs were older than seven days.
3. For merged changesets, which of these? (a) Copy forward as section 3 sets out, after a spike. (b) Wait for the shared record and delete whole files then. (c) Move merged changesets to another disk the maintainer names, which frees this disk and keeps everything, but `compare stats` would have to read both places. Recommended: (a), because (b) is unlikely to land inside two weeks, and (c) needs a second disk and a second read path.
4. Is 14 days after merge long enough? Compaction keeps every comparison and adjudication, so the age only bounds how long a merged pull request keeps its transcripts. Recommended: 14 days.
5. Should `scripted/` be pruned whole? Recommended: not until its size is known. It is often empty.
