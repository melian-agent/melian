# Sandbox housekeeping retains confinement

Supersedes: [the sandbox decision](2026-10-08-head-code-runs-in-a-sandbox.md).

Problem: head code can leave a symlink or replace a scratch directory while housekeeping runs. A host read or recursive deletion could then follow it outside the run.

Choice: every check that executes head code runs in a sandbox. macOS uses seatbelt; Linux uses bubblewrap or equivalent namespaces. A host with neither skips with leave. Writer trust remains a second control.

Scratch housekeeping stays confined after head code ends. The host retains its policy in memory and refuses symlink components. Log, report and staged-cache reads require regular files and atomic no-follow opens. A refused path is recorded without reading its target into an error.

Cleanup first unlocks each worktree, then removes its tree under retained confinement, then prunes its registration. Scratch is removed last. Missing trees, prior unlocks and missing scratch remain harmless on retry. This agrees with [the cleanup-order decision](2026-10-12-mutation-cleanup-keeps-scratch-until-unregistered.md).

Host git never recursively deletes a head-written tree. A surviving process could recreate a deleted path before unregistering it. Unlock and prune write only the trusted repository’s registration metadata.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) records these housekeeping controls without rewriting the earlier decision.
