# Core's git stops the programs git started

Amends: [The git record store refuses a stray file by where it sits](2026-11-14-git-record-store-refuses-by-location.md), the row "Child processes"

Status: for [issue #480](https://github.com/melian-agent/melian/issues/480), whose brief asks for the stop by recorded pid and its tests. The coordinator answered on 2026-11-16, in a message to the builder, that the code choosing which pids to signal moves into core unchanged, with pipeline re-exporting it, and set four conditions: the move is a move, the table is read before any signal, an unreadable table stops git alone and says so, and each exclusion has a test on a fake `kill`. That is a choice of approach, not a ruling.

## Problem

Core's `git` stopped git alone, at a call's deadline or when git flooded standard error. Git starts other programs to reach a remote: a remote helper, ssh, a credential helper. When git was stopped, such a program kept running. Example: `melian doctor` fetches `melian/state` over ssh, the key needs a passphrase, and ssh waits at its prompt. The deadline passes, git is stopped, and ssh is still waiting after doctor has exited.

A process group would end the whole tree in one call, and AGENTS.md forbids it: a group of 1 is `kill(-1)`, which ends every process the user owns.

## Choice

When core's `git` stops git, it reads the process table once, while git still runs, and records git and every process below it, each with its start time. Then it stops each recorded process by its pid, SIGTERM and then SIGKILL a second later, through `terminateRecorded`, which reads the table again before each signal and leaves alone a pid whose start time has changed. It also stops git through its own handle. It never signals this process or any of its ancestors, and never a root or a pid of 0, 1 or below. The read comes first because a process whose parent has ended is re-parented, and no longer reads as below git.

The table is read at the stop, not on a timer. A transport still waiting at the deadline is still below git when the deadline fires. A scan on a timer would also record a helper that detaches on purpose, such as git's credential-cache daemon, and kill it. A program that left git's tree before the stop is therefore not stopped.

The same stop runs when git writes more standard error than `stderrLimit`, since both are Melian stopping git before it ends.

When the table cannot be read, with no `ps` or under a sandbox that refuses it, `git` stops git alone, as before. A timed-out result then carries `childrenLeft`, and the `gitOutputTooLarge` error ends by saying the programs git started were not stopped. No pid is guessed. The same holds when a later read fails, after the first one recorded the tree: the stop then signals nothing more, so the deadline's result and the overflow error wait for the stop, about a second at most, and report it. The record store does not yet repeat this in its own `unreachable` message.

`ProcessTable`, `terminateRecorded`, `parseProcesses` and their types moved from `packages/pipeline/src/mutation-process.ts` to `packages/core/src/process-tree.ts`, unchanged, so one copy of the code chooses which pids every part of Melian signals. The new file is in the mutation check's signal set.

## The row, as it now reads

| Resource | What bounds it, or who accepted it | Test or issue |
| --- | --- | --- |
| Child processes | One git at a time, stopped at the deadline with every process below it, by recorded pid and start time. A program that left git's tree before the deadline, such as a daemon a credential helper detached, is not stopped. Where the process table cannot be read, git alone is stopped and the result says so | `core/test/git.test.ts`, "stops the transport git started, which would outlive git"; `core/test/process-tree.test.ts` |
