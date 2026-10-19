# Thinking routes: cover task definitions inside tests

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 5, keeps migration-arrow mutants on Stryker’s per-test run.
The instrumenter records an ArrowFunction mutant when its task definition loads, before the callback runs.
Calling the migration inside a test alone leaves that mutant’s coverage static.
The direct tests now reload each definition inside the test, while keeping static imports for related selection.
No model handle crosses a reset module cache.

A probe used the installed instrumenter’s own coverage counters.
Both tests first failed because their arrow mutant had zero per-test coverage.
Both pass with the reload, requiring positive per-test coverage for the arrow and returned object mutants.
All four exact hand mutations were rerun and failed their direct migration assertions.
The sources and temporary coverage probes were restored before committing.
The pass report retains both probe outputs, mutation runs and the repeated whole gate result.
No production behaviour changes. The implementation plan’s status stays unchanged.
