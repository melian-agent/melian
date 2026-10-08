# Align mutation integration fixtures with setup handling

The whole gate for [pull request #98](https://github.com/melian-agent/melian/pull/98) found two existing integration assertions that still expected setup modules in the related-test include list. They now expect related tests alone and the updated selection note. The real Vitest regression already proves the behaviour by restoring the setup append and failing.

The final whole gate passed: 118 test files and 3,215 tests passed, with 59 tests skipped. The first run found the stale assertions; the second hit three timeouts and one CLI child with no exit status under load. The one allowed whole-gate timeout retry passed. No single-file rerun replaced the gate.
