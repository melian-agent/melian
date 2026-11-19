# Issue #481: a dismissal record names the rounds its writer held

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575).

A dismissal record now carries a `frontier`: every round of the changeset that the store held as `melian dismiss --records` made it. `RecordedRound` counts as since the dismissal every round on the chain that is neither in the frontier nor an ancestor of one there, instead of stopping at the dismissal's revision. So a round that reviews the dismissal's own revision again, and cites a hunk the revision lacks, reopens the finding, as the host does. A record with no frontier counts as no dismissal.

A dismissal made with no store gets no record, and each review names it as unshared, under `madeWithoutStore`. The verification key still names it, by the ID its record would have with no frontier, so replacing it still asks the verifier again. `melian dismiss` without `--records` now says the dismissal is not shared.

The rule that a cut chain counts the dismissal as nothing is the maintainer's ruling of 2026-11-18, restated for the frontier. A branch that ends short of the frontier is cut when the writer held a round of another revision. [The decision](../decisions/2026-11-19-a-dismissal-record-names-the-rounds-its-writer-held.md) says why.

The test that reopens a dismissal at the dismissal's own revision failed before the change, with `expected [ 'passed', false ] to deeply equal [ 'findings', true ]`, and passes after it. The test of a round since the dismissal at another revision, which lacked an accepted hunk, stays `it.fails` until the reader resolves each round's revision from git, as the coordinator chose on 2026-11-20.
