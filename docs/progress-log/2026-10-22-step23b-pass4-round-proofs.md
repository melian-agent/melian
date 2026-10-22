# Step 23 build 2, pass 4: prove round selection and order

[Pull request #162](https://github.com/melian-agent/melian/pull/162) answers the final round's findings with docs and tests; no source changes.

The core guideline's stored-shape section now describes the version-2 comparison document: `comparisons` keyed by full round ID, `unattributed` holding version-1 records by `revisionKey`, and `legacy` markers.

The frozen-verdict test gave both rounds one verdict, so a reader that picked the first round at the revision passed it.
Round one now holds a finding and round two an empty verdict, and each entry's verdict and Melian findings must match its own round.
The revision-match mutation passed the old test and fails the new one.

New tests kill four surviving mutants: the missing-store refusal before opening storage, both of its mutants; the `#N` anchor on `--round`; and both round-order predicates, with comparisons recorded out of round order.
The migration arrow's `() => undefined` mutant fails five version-1 reopen tests by hand.
Stryker places its switch where `defineDoc` runs at module load, which no test reaches without a dynamic import, so it is left for dismissal with that reason.

Commits: `4bce0dee` (docs), `18a7829a` (frozen verdicts), `d90d3a3a` (survivors).
This fix pass leaves the implementation plan unchanged.
