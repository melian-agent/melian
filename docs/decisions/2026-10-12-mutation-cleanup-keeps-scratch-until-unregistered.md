# Mutation cleanup keeps scratch until unregistered

Supersedes: [the sandbox decision](2026-10-08-head-code-runs-in-a-sandbox.md), only for cleanup order.

Problem: deleting scratch before unlocking its worktree leaves a locked registration if the reviewer crashes between those steps. Retrying cleanup used to fail on the absent scratch.

Choice: unlock each worktree, remove its tree under retained confinement, then prune its registration. Remove scratch last. Each step tolerates the earlier removal or unlock. Host git never recursively deletes a head-written tree.

A crash after prune can leave an unregistered temporary scratch directory. It cannot leave a locked registration blocking the next run. Replaying cleanup at that path removes the remaining scratch.
