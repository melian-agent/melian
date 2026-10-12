# Sandbox housekeeping retains confinement

Supersedes: [the sandbox decision](2026-10-08-head-code-runs-in-a-sandbox.md).

Problem: head code can leave a symlink or replace a scratch directory while housekeeping runs. A host read or recursive deletion could then follow it outside the run.

Choice: every check that executes head code runs in a sandbox. macOS uses seatbelt; Linux uses bubblewrap or equivalent namespaces. A host with neither skips with leave. Writer trust remains a second control.

Scratch housekeeping stays confined after head code ends. The host retains its policy in memory and refuses symlink components. Log, report and staged-cache reads require regular files and atomic no-follow opens. A refused path is recorded without reading its target into an error.

Cleanup removes each tree under retained confinement, then scratch, then its own registrations. Missing trees, a missing scratch and an absent registration remain harmless on retry. [The cleanup-order decision](2026-10-12-mutation-cleanup-keeps-scratch-until-unregistered.md) records the order and why the registration goes last.

Host git never recursively deletes a head-written tree. A surviving process could recreate a deleted path before unregistering it. The host removes only its own entries in the trusted repository’s registration metadata, each matched by the tree it names; it never prunes.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) records these housekeeping controls without rewriting the earlier decision.
