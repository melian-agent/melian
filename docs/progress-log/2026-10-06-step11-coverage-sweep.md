# Fourth-round line-coverage sweep

The fourth fix pass for [pull request #89](https://github.com/melian-agent/melian/pull/89) measures ten introduced source files with c8.
Line coverage rises from 1,802/1,899 (94.89%) to 1,899/1,899 (100%).
All 97 uncovered lines intersect the branch diff. Every one now runs; none needs an unreachable exemption.
The after coverage run passes 55 suites and 1,313 tests, with one skipped.

New tests cover head-policy failures, graph rendering, compiler syntax and cleanup, native compiler output, local provisioning and prompt limits.
They use real temporary git repositories, the installed compiler, and injected local archives.
The tool-environment test clears Node's coverage variable without weakening its assertion.

Vitest 5 kills fork workers with SIGTERM, so external c8 needs an explicit flush.
Capture Vite's inline source maps as scripts load; modules can disappear before shutdown.
Generated scripts need separate identities from native Node scripts until c8 maps both to source.
The pipeline guideline records the method; tmp/fix89d-report.md holds the evidence, line inventory and final gate.

The final gate passes 76 test files and 1,713 tests, with 50 skipped and no vulnerabilities.
Its first attempt caught two missing repository arguments in the new caller fixture; the corrected fixture passes.
No final gate test or registry timeout occurred.
