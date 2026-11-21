# [Issue #481](https://github.com/melian-agent/melian/issues/481): the reader tests each round at its own revision

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575).

`RecordedRound` now tests each round since a dismissal at the revision that round reviewed, as the host tested each sighting when it was seen. It resolves that revision from the checkout's git, by its base and head, with `Changeset.resolve`, the diff the CLI reads the read round from. A round after a retarget is tested at its own base. `contents` is now asynchronous and takes the checkout. A commit the checkout lacks, as in a shallow clone, refuses the round and names the commit; it never lets the dismissal hold.

The coordinator chose this design, the builder's option (a), on 2026-11-20, after the maintainer said he had no preference; it is the coordinator's choice, not a ruling. [The frontier decision](../decisions/2026-11-19-a-dismissal-record-names-the-rounds-its-writer-held.md) and the cli guideline's `findings --records` row say that the reader needs the repository's history.

The test of a round since the dismissal at a revision that lacked an accepted hunk was `it.fails` before the change, failing with `expected [ 'passed', false ] to deeply equal [ 'findings', true ]`. It is `it` now and passes. With the since-round test forced to hold, it and the retarget test that takes `src/a.ts` fail.

The tests that build rounds at made-up commits now build real ones, since the reader resolves every revision it needs.

A property test checks the reader against the host's own lifecycle over 24 seeded random histories, with each revision read from git. The reader never keeps a dismissal the host reopened, and on these histories the two agree every time: five keep it and nineteen reopen it. With the since-round test forced to hold, seed 2 fails.
