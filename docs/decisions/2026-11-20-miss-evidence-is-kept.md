# A valid miss keeps the conversations behind it, in a durable, bounded evidence directory

Amends: [2026-11-14-store-retention.md](2026-11-14-store-retention.md), for `evidence/` as a durable part of the store, its budget, and its 90-day prune

Recorded by a builder agent on 2026-11-20 for [issue #559](https://github.com/melian-agent/melian/issues/559), item 3. The coordinator accepted the numbers here, 16 MiB a stage, a 1 GiB budget and 90 days, on 2026-11-20. That is a coordinator's choice of approach, not a maintainer's ruling.

## Problem

A comparison records that Melian missed a finding another reviewer raised, and a maintainer judges the miss valid. To learn why, someone must read what the lenses saw in the round that missed it. That lives only in the round's telemetry, in the changeset's working state. A rerun of the same head on a host gives a new conversation, not the one that missed.

Example: a Codex finding at `src/user.ts:30` is judged a valid miss. The correctness lens covered the file in round `r1`. Once a later round of the branch replaces the telemetry Melian reads, nothing can show whether that lens read line 30.

## Decision

1. When `melian compare adjudicate` judges an external finding `valid` and no match names it, Melian copies its evidence. A Melian finding, a matched external finding and any other verdict keep nothing.
2. The evidence is the round's lens conversations whose coverage holds the miss's file, the verifier conversations whose claims include a lens sighting overlapping the miss's lines, every entry of each, and the round's base, head and policy commits, with the blob IDs of the lens files at the policy commit. Deciding whether a lens saw the lines, and naming the cause, is later work.
3. It lives in the state directory, beside the changeset files, at `evidence/<changeset>/<round>/stages/<stage>.json.gz`, one file per stage written once however many misses share it, and `evidence/<changeset>/<round>/misses/<external>.json`, the pointer. In scripted mode the directory is under `scripted/`. Every name is checked before it becomes a path: a changeset ID, a round's local name, a stage ID and a 16-digit external ID.
4. Files are written with mode 0600 and directories with 0700, each file through a temporary file renamed into place. Every component is read with `lstat`, and a link anywhere on the path is refused. A write that fails removes every file and directory it created.
5. A stage keeps its first entry and as many of its last entries as fit in 16 MiB of JSON, and records how many it dropped.
6. `evidence.budget` in the root `melian.yaml` or the user's preferences, 1 GiB by default, bounds the directory. A write that would pass it is refused with a message naming the directory and `melian store prune`. The adjudication is still recorded, and the command exits 1.
7. `melian doctor` prints the directory's size and the budget.
8. `melian store prune` lists `evidence/` as durable and never removes it.
9. `melian compare evidence <range|#pr> <external-id> [--round <id>] [--json]` prints the evidence through visible text.
10. A round whose run this clone holds no telemetry for keeps nothing, and the command says why. An Actions round's telemetry went with its job.
11. Nothing else reads the directory. It holds the head's code and tool output, so no comparison, export, record, artefact or comment carries it.

## The 90-day prune is not built

The brief asked that `--apply` remove the evidence of a changeset merged more than 90 days ago, learning of the merge as prune already does. Prune learns of no merge: no code reads a pull request's merge time, and the GitHub reader takes only the merge commit. [The store retention decision](2026-11-14-store-retention.md) also says that if prune ever removes anything durable, its races between the plan and each removal must be closed first. So prune keeps the directory whole, and the budget is the only bound until a merge-time source and that exclusion exist. The question is with the coordinator.

## What this gives up

- The directory grows until a maintainer raises the budget or removes evidence by hand.
- A round reviewed on Actions, or on another host, keeps no evidence here.
