# Publication of coverage settles three questions the design left to the build

Amends: [the coverage decision](2026-10-23-coverage-ledger-and-delta-review.md), its build 3: what a published round says it reviewed, how much of the ledger a body carries, and what a round with no record says

For plan step 24, build 3, after [the build 2 decision](2026-10-25-coverage-ledger-build-2.md). It builds the publication part of build 3: the review body and the ledger comment say which lines the round reviewed, which rounds cover the diff, and each gap. [Melian's flow]

## Choices

1. **A round reviewed what its lenses received.** The body counts the changed lines the round's own lens runs delivered, of all the changed lines its lenses must cover, and names the files they sit in. A delta prompt delivers the earlier hunks as context, and the ledger counts a delivered line as covered, so a delta round's count includes them. Counting only the delta's own hunks would say less than the ledger records. Whole-range checks, such as Biome and tsc, cover the whole diff every round and are not counted.
2. **A body lists twenty of each.** It lists the first twenty gaps, in the ledger's order, and the first twenty reviewed files, and counts the rest. `melian findings "#N"` lists every gap. GitHub keeps 140 characters of a status description, so the status names the first gap and the body the rest.
3. **A round with no ledger record says nothing of coverage.** A round an earlier build decided wrote no record. Its body and its entry in the ledger comment carry no coverage section, as before the ledger existed. Its verdict has no `review.coverage` record, so nothing gates on a ledger it never had.

The comparison part of build 3 waits for step 23's builds 3 and 4: `#N` writes that choose a covering round, and a carried finding counted once.
