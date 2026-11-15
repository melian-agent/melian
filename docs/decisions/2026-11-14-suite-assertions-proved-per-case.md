# A shared test suite's duplicate assertions are listed, not proved one by one

Amends: [docs/decisions/2026-11-04-mutation-proof-scope.md](2026-11-04-mutation-proof-scope.md), mutants inside a test suite kept under a source folder

The maintainer ruled on 2026-11-14, in the coordinator's session, on [pull request #399](https://github.com/melian-agent/melian/pull/399).

## The problem

A conformance suite is a set of tests any implementation of a port must pass. It lives under a source folder so another package can import it, so the enumerator lists mutants in the suite itself. Proving one means writing a deliberately broken implementation that only that mutant lets through.

Pull request #399's record-store suite had 46 such mutants. Sixteen deleted the only assertion of a promise. Twenty-two deleted an assertion that a neighbouring assertion in the same case also catches. Eight changed fixture housekeeping, such as closing a file handle. A broken store for each of the last thirty would take hours, and several would be contrived: no store can get "close the file handle" wrong.

## The rule

- An assertion that is a case's only check of a promise is proved as any mutant is: a broken implementation, the named case passing unmutated and failing with the mutant.
- A mutant that deletes an assertion another assertion in the same case also catches, or that changes fixture housekeeping, is listed in the inventory by line with a one-line reason, under the label "suite assertion, proved per case". It is never claimed as equivalent, because it is not.
- The reason of a deleted-assertion row names the neighbouring assertion that catches the same promise, by line, and that neighbour is one of the proved ones. A reviewer's sample selects every listed row, so the label is a claim a reviewer reads, never proof.
- The rule covers only a test suite kept under a source folder for other packages to import. Mutants in any other source file are proved as before.

## What this gives up

A listed assertion could be deleted and no test would fail. The promise it checks stays covered by its neighbour, which is proved. That the neighbour covers the same promise is the builder's judgement, checked by a reviewer who reads the row, not by a run.
