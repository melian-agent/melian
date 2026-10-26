# 2026-10-26: bound argument errors and order graph lists

The maintainer ruled on both remaining classes from the probe rerun at `0729832b` on [pull request #207](https://github.com/melian-agent/melian/pull/207). The probes became regression tests before either fix.

Commit `9d612182` gives all seven read tools one `prepareArguments` guard. It refuses serialised arguments above 8 KiB. It preflights smaller calls with Pi's validator. Commit `9d612182` replaced every schema failure with one fixed refusal; the gate then showed a model could no longer tell what it got wrong, so the coordinator's follow-up commits pass on Pi's error without its echo of the arguments, which also bounds malformed nested JSON. [Issue #248](https://github.com/melian-agent/melian/issues/248) tracks bounding validation errors in Pi. The shared factory preserves each tool's schema, execution and output limits.

Commit `b4380ee9` shares the declaration comparator across definitions, references and callees: name, file, numeric line and ID, then edge kind for equal facts. Impact keeps nearest depth first and sorts each whole depth before its node cap. Reversing facts and relations therefore preserves the answer and which rows survive truncation. Tests cover all four keys, absent locations, 2 and 2,001 relations, and the node cap across two caller groups.

The ten argument regressions failed on `0729832b` with echoed schema errors or calls passing the missing guard. Nine ordering regressions failed against that head's production files. Final verification passed all 77 tests across `lens-tool-arguments.test.ts`, `graph-tools.test.ts` and `enola-graph.test.ts`. Type checking, targeted Biome checks and `git diff --check` passed. An initial graph test timed out; its whole file passed on rerun.

The complete `0729832b...HEAD` inventory has 63 mutants and omits none. The scratch script applied each mutant alone and ran its named test file. Tests killed 61. The two survivors change only the synthetic call's type or ID, which Pi's argument validator does not read; both are equivalent. Every classification, named failing test and run result is recorded. The documented macOS stdin `EAGAIN` required a temporary streamed read in the instrumenter, restored before committing.

Evidence remains under `/Users/tal/dev/Melian/tmp/m2/codex-207-fix6/`: `inventory.json`, `run-mutants.py`, per-mutant logs, `guard-failing.log`, `order-failing-0729832b.log`, `order-passing.log`, `typecheck.log` and `report.md`.

Only targeted test files ran in the builder sandbox. The host must run the full gate. This fix pass leaves the implementation plan and comparison records unchanged.
