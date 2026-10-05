# Codex sandbox residual limits

The sandbox confines where a task writes. It cannot govern what the host later does with those files.

Melian's sixteenth review of `2dc4cb1` on [pull request #74](https://github.com/melian-agent/melian/pull/74) found a repository-planting route. A task can build a repository in the exempt per-run temp directory, then rename its parent directory into the worktree or scratch. Seatbelt checks the rename's source and destination, never the descendants. The `.git` and `HEAD` denies therefore do not fire. A planted repository's config can run code when the host runs git inside it.

Choice: Keep the per-run exemption. The host treats everything under the worktree and scratch as untrusted, reviews it through the pull request, and never runs git inside a directory a task created. The maintainer dismisses the sixteenth round's finding under this rule. A planted repository under the worktree affects only a host that enters it.

Why: Denying directory renames into the worktree would break `npm ci` and git. Removing the temp-directory exemption would break Melian's tests, which create repositories there. The host rule already applies to task-written hooks, scripts and symlinks. It also covers repositories moved out of temp storage.

The sandbox still closes these routes, within the limits the [README](../../README.md#running-codex-tasks) records:

- Direct creation of `.git` components and `HEAD` or `commondir` files anywhere persistently writable, apart from git's documented state-file allowances. These path checks do not inspect a renamed directory's descendants.
- Writes to git hooks and config, and the administrative directory's `commondir` and `gitdir` pointers.
- Writes to Codex's home outside its runtime allowances, including `config.toml` and hooks. Runtime paths cannot move or become symlinks; `auth.json` remains writable for login refresh.
- Symlink creation in the worktree outside `node_modules`, moving or copying symlinks into it, and `chflags`. Links under `node_modules` remain untrusted.
- Mach lookups outside the named services, including launchd and LaunchServices, and unix sockets other than the DNS resolver's. IP networking remains open.
- Reads of SSH, Pi and npm credential files, and root `.env` files in the worktree and main checkout. Root `.env` files also resist writes and renames. Secret environment variables are dropped; Codex auth, gh configuration and keychain credentials remain available. Nested `.env` files and other home files remain readable.
