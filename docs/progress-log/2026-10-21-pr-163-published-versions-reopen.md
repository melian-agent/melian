# Recorded reopens for every accepted publication version

[Pull request #163](https://github.com/melian-agent/melian/pull/163) adds tests for `melian.published` version 9's accepted source versions.
Production behaviour, document versions and dependencies stay unchanged.

The audit found no fixture written by versions 1, 2, 3, 4 or 6.
Version 5 already had a populated recording, version 7 an empty one, and version 8 populated recordings.
The fixtures now cover the missing versions and add version-7 dismissals, including a changed reason whose reply remains owed.
This fills the omissions named in [the progress entry for pull request #155](2026-10-18-pr-155-orphan-thread-core.md).

Each source ran at the last commit carrying its version, with its own unchanged lockfile, fake models and fake GitHub.
Version 4 never reached main alone; its recording comes from the last ledger-branch commit before version 5.
The sandbox refused creation of a scratch worktree's Git metadata, so exact `git archive` trees stood in for worktrees.
Every production source file and both root manifests matched its archive after recording.
Compact source snapshots contain no local paths.
The fixture README names all source commits.

Twenty-one SQLite cases compare the complete upgraded value, write version 9, then check another reopen.
Independent expected JSON never calls a migration.
Version-1 cases preserve evidence converted in both a pending post and its verdict, plus ID-keyed replies converted to thread keys.
Version 4 compacts older full ledger rounds, version 6 retains per-lens standards, and version 7 preserves untrusted attribution and dismissal payloads.

Every case fails under a hand-broken migration for its version.
Thirteen mutations cover evidence conversion, reply rekeying, settled and pending resolution rekeying, history compaction, attribution preservation and version-specific bypasses.
No mutation remains, and no migration defect was exposed.
The new test code adds no production guard, branch, bound or early return.
A separate type check caught the imported JSON union's inferred optional fields; the document boundary now reads JSON as in the existing version-8 test.
Type checking and all 21 reopen cases pass.

Implementation commits: `bb00e5d1` (version 1), `7082b0a8` (version 2), `f66f6026` (version 3), `2d51b722` (version 4), `83f56afa` (version 6), `f0c7ff5b` (version 7), and `70aa8efe` (JSON typing).

The lane report retains the whole-gate output and lists sandbox denials.
A separate host gate remains required after this Codex pass.
Live review rounds remain with the coordinator: this brief forbids live model calls and subagents.
The report, mutation inventory, recorders and logs remain under the main checkout's `tmp/m2/scratch-published-v1/`.
