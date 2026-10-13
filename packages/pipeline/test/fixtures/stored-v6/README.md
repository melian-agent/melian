# Recorded state from before check records carried confinement

`checks.json` and `review.json` hold document snapshots produced by the code at `571859b2`, the commit before a check record gained its `confinement` field. The checks document was version 3, the verdict document version 6, and the published document version 7; the three numbers in the files were read from that commit's `defineDoc` calls. This is recorded output, not a hand-built old shape.

`checks.json` came from `runChecks` on a two-commit repository with the tier `guardrails, static.biome, static.tsc`, through a memory-storage harness with the checks extension, as `test/checks.test.ts` sets one up. The real Biome and tsc ran, inside seatbelt on the recording host. The file is the `ChecksDocument` snapshot.

`review.json` came from the GitHub fixtures: `scenarioRepository`, `scenarioModels`, `reviewScenario` with `lensScript(unsafeManager)` and the three check records from `checks.json` passed as its checks, then `publishReview` through `createGitHubProvider` with `fakeGitHub` as its fetch. The file is the `VerdictDocument` and `PublishedDocument` snapshots. Every model reply and GitHub response was fake.

Both recordings ran as one-off Vitest files that were deleted afterwards. No repository environment file or provider credential was loaded.

`test/confinement-migration.test.ts` writes these values through document tokens of the recorded versions into SQLite, closes storage, and reads and writes them through the current definitions across a second reopen.
