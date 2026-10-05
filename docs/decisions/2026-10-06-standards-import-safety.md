# Standards imports stay inside the selected source

Date: 2026-10-06

A nested AGENTS.md can import a maintainer's ignored secrets file. Reading the checkout would send its contents to a model.

Revision imports read tracked blobs from that revision only. Git evaluates that revision's ignore files, plus the clone's local exclusions. Worktree imports may read uncommitted files but refuse ignored files. Both sources refuse melian.secrets.yaml, melian.local.yaml and .env* in any case, before reading them. The lens check record names refused imports and the review continues.

A checked-out CLI range reads standards from its head commit. Other ranges and pull requests read them from the base. Hosts use worktree standards only for uncommitted changes. Policy preferences retain their existing source.
