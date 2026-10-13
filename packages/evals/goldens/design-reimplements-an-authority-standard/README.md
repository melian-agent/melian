# design-reimplements-an-authority-standard

From the review of record for [pull request #114](https://github.com/melian-agent/melian/pull/114), which asked that the boundary with `conventions` be measured and not only rendered. The trees are those of `design-reimplements-an-authority-clean`, with a standard added: `AGENTS.md` says to compare versions with `semver` and never by hand. The head compares the running Node by hand in a `preinstall` script and states a gap that the code supports.

A review must report one finding, `quoted-rule-violation` from `conventions`. `design` hands this case to `conventions`, stated gap or not, because a written standard allows no exception it does not state.

The expected file can say which lens must report, through `source`. It cannot say that `design` must stay silent: a `design` finding on the same lines merges with the `conventions` one into one defect, and a merged sighting costs no precision. A `design` finding elsewhere in the file would cost precision. A live run record should count `design`'s sightings on this golden by hand.
