# Head code runs in a sandbox

Problem: a check can execute a pull request's tests, configuration, or plugin. Writer trust cannot stop that code reading credentials or using the network.

Choice: every check that executes head code runs in a sandbox. macOS uses a seatbelt profile. Linux uses bubblewrap or an equivalent namespace sandbox. A host with neither skips the check with leave.

Writer trust remains a second control. It decides whose code may run, but it does not replace isolation. [The mutation decision](2026-10-08-mutation-testing-as-a-static-check.md) applies this rule in [pull request #98](https://github.com/melian-agent/melian/pull/98).

Scratch housekeeping stays confined after head code ends. The host retains the policy in memory and refuses symlinks in scratch paths. Log, report and staged-cache reads require regular files and atomic no-follow opens. A refused path is recorded without reading its target into an error.

Post-run registration cleanup. After confined deletion, the host unlocks the worktree and prunes its missing registration. It never asks host git to remove the scratch tree recursively. A surviving head process could recreate that path between deletion and unregistering; git remove would then trust the recreated path. Unlock and prune write only the trusted repository’s registration metadata.
