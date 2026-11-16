# The record store sweeps what a killed call left, once its maker is gone

Amends: [The git record store refuses a stray file by where it sits](2026-11-14-git-record-store-refuses-by-location.md), the row "The same, left by a process killed mid-call, and a fetch ref left by a call whose deadline ran out before it could delete the ref"

Status: for [issue #460](https://github.com/melian-agent/melian/issues/460). The maintainer accepted on 2026-11-15, in the coordinator's session, that these leftovers wait for this issue. The method below is the coordinator's choice of approach, given on 2026-11-16 in a message to the builder, with the conditions it set; it is not a ruling. The host's hash in each name is the builder's addition, which the coordinator agreed to on 2026-11-16, asking that its limit be stated here.

## Problem

A call on the git record store makes three things and removes them before it returns: a temporary index inside `records.git`, a half-made repository beside it while the store is first created, and a fetch ref under `refs/melian/fetch/`. A process killed mid-call removes none of them, and neither does a call whose deadline runs out between its fetch and the ref's deletion. Example: `melian doctor` is killed during its fetch. The fetch ref it made pins every object it fetched, and nothing ever deletes it, so each such kill leaves one more.

Two processes can share one state directory, so a sweep that removed every leftover it found would delete the temporary index of a call still running beside it. An age proves nothing either: a caller sets its own deadline, so a call can legitimately run for longer than any cut-off.

## Choice

Each leftover's name records its owner: the first 16 hex digits of a SHA-256 of the host's name, the pid, and the start time `ps` gives for that pid, as UTF-8 bytes in lower-case hex, then a UUID that keeps two names of one call apart. Opening the store sweeps the state directory. It removes a leftover only when all of these hold:

- Its name parses as an owner, and the host's hash is this host's.
- The process table, read through core's `ProcessTable`, lists no process with that pid, or lists it with another start time.
- It is the kind of thing the store makes under that name: a directory for a half-made repository, a regular file for an index or its lock, and a ref directly under `refs/melian/fetch/`.

The sweep lists the leftovers before it reads the table. A call still running when the table is read is in it, and a call that started after the listing made nothing the listing holds. A pid reused within the second `ps` reports reads as the owner, so its leftover is kept, which costs disk and loses nothing.

Everything else is kept: a leftover from another host, one whose name records no owner, as an earlier build's UUID names do, one whose name does not parse, and an entry of the wrong kind, a link included. The sweep never follows a link and removes nothing outside the state directory and `records.git`'s refs. When the table cannot be read, it sweeps nothing. When this process cannot find itself in the table, the call names what it makes by a UUID alone, which no sweep removes. A removal that fails is recorded, and the store still opens. `melian doctor` names every leftover the sweep kept, every one it could not remove, and a table it could not read, so a person knows what is safe to remove by hand.

## Why

A pid with its start time names one process, as core's rule for signals already uses it, so a sweep that finds the pair gone knows no live call owns the leftover. Keeping whatever it cannot prove gone means a mistake costs disk, never a live call's index.

The host's hash keeps a state directory shared with another host, or with a container whose processes this table cannot see, from reading that host's live call as gone, since its pid is absent here. It is a guard, not a guarantee: two hosts or two containers that report the same host name read as one, so a state directory shared between them can still have a live call's leftovers swept. Melian does not support sharing a state directory across hosts. A container's pid namespace could be told apart from what the kernel reports; [issue #460](https://github.com/melian-agent/melian/issues/460) records that for later.

## The row it replaces

| Resource | What bounds it, or who accepted it | Test or issue |
| --- | --- | --- |
| The same, left by a process killed mid-call, and a fetch ref left by a call whose deadline ran out before it could delete the ref | Removed when a later handle opens the store on this host, once the process table shows the owner its name records is gone. Kept, and named by `melian doctor`, when the owner is alive, on another host, or not recorded, when the name does not parse, when the entry is not the kind the store makes, and when the table cannot be read | `sweep.test.ts`; `create.test.ts`, "names the repository it builds after this host and process, …"; `doctor-record-store.test.ts` |
