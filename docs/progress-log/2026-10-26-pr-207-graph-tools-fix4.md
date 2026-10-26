# 2026-10-26: graph lens tools read without cache writes

Finding `2d86ae23d98d8c14` from Melian's review of `94dce470` on [pull request #207](https://github.com/melian-agent/melian/pull/207) exposed filesystem writes behind the read-only graph tools. `GraphCache.open` created directories and swept scratch entries from dead processes.

Commit `315e556e` adds `GraphCache.openReadOnly` and routes the graph tools through it. The reader uses the existing bounded reads and artifact verification. It creates no directories, opens no `CacheScratch`, and refuses stores. A missing cache or entry keeps the existing unavailable answer.

Before the fix, the three new graph-tool cases failed on `94dce470`. The tool deleted a dead child's scratch directory and created absent graph and cache-root directories. After the fix, both targeted files passed all 40 tests. The read-only cache test checks a verified read, corrupt-artifact refusal and store refusal. Targeted Biome checks and `git diff --check` passed.

Enumeration with `node scripts/enumerate-mutants.mjs 94dce470...HEAD --json --limit 10000` lists six mutants and omits none. Each was classified, applied alone and killed by its named test, including the configured ignored string mutant. A separate mutation restoring `GraphCache.open` failed all three regression cases. No mutants survived. Enumeration at the committed head matches the inventory used before committing. The documented macOS stdin `EAGAIN` required a scratch preload that makes the instrumenter's stdin blocking; repository scripts stayed unchanged.

Evidence remains under `/Users/tal/dev/Melian/tmp/m2/codex-207-fix4/`: `inventory.json`, `run-mutants.py`, `mutant-0.log` through `mutant-6.log`, `failing.log`, `passing.log` and `final-targeted.log`.

The builder ran only targeted test files. The host must run the full gate.
