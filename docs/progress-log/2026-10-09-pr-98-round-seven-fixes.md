# [Pull request #98](https://github.com/melian-agent/melian/pull/98): round-seven mutation fixes

Round seven found stale mutation authority, incomplete installation identity, setup-only coverage gaps and budget findings that could never clear.
The fix pass started at 47aa76a5. Each fix was committed and pushed separately.

- b008c63a includes the test runner's Node version in the shared run and cache installation identity.
  Removing it fails the cache-reopen and same-storage run tests.
- fbd912fc retires the revision's mutation authority when a known tier omits mutation.
  SQLite crash tests cover retirement before abort and after reopen. Dropping retirement or abort fails them.
  Pi cannot abort inside a durable commit. The owner changes durably first; abort completes before task submission.
- 133ee4de selects the whole suite when a setup file reaches changed production code.
  Dropping setup reachability fails the selector and real Vitest regressions.
- 43bf8394 makes the whole-suite fallback fake reject a restricted include.
  Restoring the include fails the test.
- 68bf5695 checks the excluded mutators supplied to uncovered enumeration.
  Replacing them with an empty array fails the StringLiteral test.
- 5bb7a007 excludes Melian's three production signal files from automatic mutation.
  Harmless fixtures prove the exclusion and its reason. Real signal source is never mutated.
- 5829e59c replaces per-file budget acknowledgements with one P3 notice naming the omitted line count and budget.
  Restoring per-file findings, dropping the count or removing the budget guard fails the boundary tests.
  Timeout and ignoreStatic findings keep their P2 shape. Design, decision and guideline text changed with the fix.
- f4d3b175 kills the donor-tie survivor with a 49/49/1-line change and a 20-line budget.
- 0c4dd9cd kills the five test-selection survivor findings: default limits, mixed missing sources, queue end,
  phantom importers and missing or reversed sorting.
- e163293a proves compiler configuration discovery, membership and property guards.
  Tests cover configuration names and quoted property names that the surviving mutants mishandled.
- db1dc3d6 proves descriptor closure on valid, corrupt and oversized cache reads.
- 272b12fc proves ancestor traversal stops at the root. A bounded dirname fake makes the loop mutant fail promptly.
- ae16b05f covers process-table requests, failed requests and start lookup with fakes.
  Eight process survivor findings have failing isolated contract probes with no real signal or subprocess API.
- cdd86da0 removes TSDoc from internal mutation declarations, as the package documentation rule requires.

The trustedWriter mutant is equivalent: the earlier trust gate requires true before mutation runs, and other tools ignore it.
The compiler fallback's extensionless phantom module is equivalent because it cannot enter the compiler's source snapshot.
The extra final-extension-dot regex variant is equivalent for the same reason.

The report accounts for all 22 survivor findings: twelve direct failing mutation proofs, eight fake process proofs and two equivalent findings.
No budget-omitted line was targeted. Signal source was not instrumented or mutated.

The full gate passed on its first run: 118 test files passed and two skipped; 3,284 tests passed and 61 skipped.
The mutation inventory, skipped-test list and verbatim summary are in tmp/fix98-r7-report.md.
The gate log is tmp/fix98-r7-check.log.
Real seatbelt, bubblewrap and ps-dependent tests need the host coordinator where this sandbox skips them.
