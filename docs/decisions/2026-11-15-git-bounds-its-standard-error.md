# Core's git bounds the standard error it keeps

Amends: [The git record store refuses a stray file by where it sits](2026-11-14-git-record-store-refuses-by-location.md), the row "Memory for git's other output"

Status: for [issue #469](https://github.com/melian-agent/melian/issues/469), whose brief asks for the bound, the named error and the tests. The coordinator answered on 2026-11-15, in a message to the builder, that the bound opens against `main` first and that this amendment follows once [pull request #433](https://github.com/melian-agent/melian/pull/433) lands. That is a choice of approach, not a ruling. The number and the store's handling of a stopped command are the builder's choices.

## Problem

Core's `git` kept a command's standard error whole. A fetch or a push carries there whatever the remote sends, and a credential helper's output too. A remote that writes without end, such as a `post-receive` hook running `yes >&2`, filled the Melian process's memory well inside any deadline. The amended decision's table listed that row as not bounded.

Cutting the stream would not be enough. The record store reads a fetch's standard error for `couldn't find remote ref`, which means the branch is absent, and a ref update's for `cannot lock ref`, which means another process holds a lock for a moment. A remote that prints either phrase and then floods would leave a cut message that still matches, so the store would read a full branch as empty, or retry a failure that no retry clears.

## Choice

Core's `git` keeps at most `stderrLimit`, 4 MiB, of a command's standard error. One byte past it, `git` stops the command by its own pid, closes its end of the stream so a transport that shares it keeps nothing of the process alive, and rejects with `ChangesetError` `gitOutputTooLarge`. It never resolves with part of the stream, so no caller can read a cut message as a failure it knows.

The bound sits far above anything a legitimate command writes. Across the whole test suite, before the tests that flood standard error on purpose, 111,982 git calls wrote at most 250 bytes of it each.

The record store turns that error into its own `unreachable`, naming the command, so a fetch or a ref deletion stopped this way fails the call and is never read as an absent branch or a held lock. A push is different: a remote's hook can write after the ref has moved, so a push stopped for its standard error may have landed. The push answers `stopped`, the outcome a push stopped at its deadline already had under the name `timedOut`, and the store checks whether it landed as it does after a deadline.

## The row, as it now reads

| Resource | What bounds it, or who accepted it | Test or issue |
| --- | --- | --- |
| Memory for git's other output | 4 MiB of standard error, core's `stderrLimit`; one byte past it core's `git` stops the command and rejects, and the store reads that as `unreachable`, or as a push that may have landed | `core/test/git.test.ts`, "git with a standard error past its limit"; `state-git/test/repository.test.ts` and `writes.test.ts`, the tests that flood |
