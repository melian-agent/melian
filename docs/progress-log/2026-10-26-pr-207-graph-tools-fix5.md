# 2026-10-26: bound lens replies and stabilise declaration order

The review of record probed `9ea31165` on [pull request #207](https://github.com/melian-agent/melian/pull/207). Its dense graph, oversized search errors and reversed declaration facts became regression tests before the fixes.

Commit `a6aeb99f` routes every lens tool body, diagnostics included, through `fitting` in the shared `text` constructor. It enforces 48 KiB and 2000 lines before adding boundaries and notes. A cut reply names the omitted lines and marks a shortened line. Graph warnings precede the rows, so the closing boundary survives. Error messages shorten and quote patterns and outside paths. Read continuation and per-file search notes remain intact.

Commit `fd401324` orders declarations by name, file, numeric line and ID. Tests reverse each pair's fact order and assert the whole answer. They cover each key and absent file or line values.

Before fixing, the graph case delivered 2053 lines after Pi cut it. The pattern error returned 104163 bytes; the newline path returned 5003 lines. Five ordering cases failed while `enola-graph.ts` still matched `9ea31165`. Bounding verification passed 331 tests across four targeted files. The final graph file passed 36 tests after tightening its fakes. Sorting verification passed all 58 core and graph tests. Biome, type checking and `git diff --check` passed.

The complete `9ea31165...HEAD` inventory lists 170 mutants and omits none. Each was classified, applied alone and killed by a named test. The committed inventory matches the proof inventory. The existing scratch stdin preload worked around the documented macOS enumeration `EAGAIN`; repository scripts stayed unchanged.

Evidence remains under `/Users/tal/dev/Melian/tmp/m2/codex-207-fix5/`: `inventory.json`, `run-mutants.py`, per-mutant logs, `bounding-before.log`, `search-before.log`, `quoted-before.log`, `sort-before.log`, `bounding-final.log`, `bounding-graph-final.log` and `sort-final.log`.

The builder ran only targeted test files. The host must run the full gate. This fix pass leaves the implementation plan and comparison records unchanged.
