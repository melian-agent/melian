# The sandbox grants nothing in the user's temporary directory

Supersedes: none.

Problem: the seatbelt profile let a sandboxed command read and write `xcrun_db`, and any `xcrun_db-<suffix>` beside it, in the host's per-user temporary directory. That file is the cache `xcrun` keeps of where the developer tools are, and macOS's `/usr/bin/git` is a shim that reads it. Host git reads the same file after the sandboxed command ends.

Example: head code inside the sandbox rewrites `xcrun_db` to name a program in scratch as `git`. The next `git worktree list` Melian runs on the host, outside any sandbox, starts that program as the reviewer.

The grant existed so that a test which runs `/usr/bin/git` with an environment of its own, and so meets the shim, saw no complaint on stderr. A second grant came with it: a Mach lookup of `com.apple.bsd.dirhelper`, the service that tells `xcrun` where the per-user temporary directory is.

What was tried, on macOS 26 with the command-line tools selected, running `/usr/bin/git init` inside the sandbox:

| Profile | Child's environment | Exit | Stderr |
| --- | --- | --- | --- |
| Read and write grant, as before | any | 0 | empty |
| No cache grant, dirhelper allowed | any, with or without `TMPDIR` or `DEVELOPER_DIR` | 0 | "couldn't create cache file" twice |
| Read-only literal `xcrun_db`, dirhelper allowed | any | 0 | empty, while the host's cache is fresh |
| No cache grant, no dirhelper | `HOME` and a scratch `TMPDIR` | 0 | empty; the cache lands in `TMPDIR` |
| No cache grant, no dirhelper | `HOME` only | 0 | a `confstr` warning, then "couldn't create cache file" in `/tmp` |

The shim runs the real git in every row. `DEVELOPER_DIR` changes none of them. With the directory service denied, `xcrun` cannot learn the per-user directory and falls back to `TMPDIR`.

Choice: no cache grant and no Mach lookup. The profile allows no Mach service at all and no path in the per-user temporary directory outside scratch. Every command Melian starts in the sandbox gets a `TMPDIR` in scratch, so the shim keeps its cache there and says nothing. `Sandbox.environment()` still puts the real git ahead of the shim in `PATH`, so a command that calls plain `git` never meets it.

A read-only literal was the smaller change and was rejected: it grants a read outside scratch to save two lines of stderr, and stays quiet only while the host's cache happens to be fresh.

What this gives up: a child started with a hand-built environment that has no `TMPDIR` still gets a working git, with two warnings on its stderr. A test that compares a git command's stderr must pass its child a `TMPDIR`, as it must pass a `HOME`.

A cache in scratch is one head code can write. That is no gain for it: only commands inside the sandbox read `TMPDIR` there, and they already run what head code chooses. The rule this depends on is that the host never runs git with `TMPDIR` pointed into a scratch directory.

A real-sandbox test asks a sandboxed command to create a file in the per-user temporary directory under a name the old grant matched, to append to one, to replace it, to read it, and to list the directory; each must fail.
