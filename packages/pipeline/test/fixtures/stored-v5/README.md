# Recorded version-5 state

`review.json` holds snapshots produced by the review and publication code at `5b79a4e`, before step 9. Both document definitions were version 5. This is recorded output, not a hand-built old shape.

The recording ran that commit's `scenarioRepository`, `scenarioModels`, `reviewScenario` and `lensScript(unsafeManager)` from the GitHub fixtures. It awaited the review, moved the fake pull request to that revision, then called `publishReview` through `createGitHubProvider` with `fakeGitHub` as its fetch. It read `VerdictDocument` and `PublishedDocument` snapshots from memory storage. Every model reply and GitHub response was fake.

The source came from `git archive 5b79a4e` over `packages/core/src`, `packages/core/lenses`, `packages/pipeline/src`, `packages/github/src` and `packages/github/test/fixtures`, with the root `package.json`. A Node resolve hook mapped every workspace import to that archive. External packages came from the current pinned installation. No repository environment file or provider credential was loaded.

The SQLite test writes these recorded values through version-5 document tokens, closes storage, then reads and writes them through the current definitions. It checks both upgrades across a second reopen. Generated commit IDs, task IDs and fake publication markers are retained as recorded.
