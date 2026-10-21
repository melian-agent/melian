# Prove retirement and dismissal selection

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 5.
The retirement survivor replaces only the inner thread-presence check with true.
The earlier test mutated the whole conjunction and missed body-only assignments.
A new test retains a historical body-only resolution while assigning another body-only finding.
All five mutants on the line now fail.

A second test follows an older dismissed finding past a newer record holding only another finding.
The older record contains both IDs, so replacing some with every also fails.
All eight mutants on the lookup line fail. The restored 22-test publication suite passes.

The reported round-number survivor removes optional chaining; it does not change the arithmetic.
The status commit establishes the head record before that access, making this mutant equivalent.
The other three mutants on that line fail the direct round-number tests.
Vitest selects those tests for publish.ts. No test move or document-version change is needed.
The appended inventory and exact runs are in `tmp/orphan-thread-pass5-report.md`.
