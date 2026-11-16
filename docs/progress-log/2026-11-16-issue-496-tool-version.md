# Issue #496: a check's tool version leaves the machine only as a version

The record classes' inventory found a static check's `version` unclassed: `staticToolVersion` reads it from the tool's installed `package.json`, which the head's install wrote. `ReviewRecords` now exports it only when `valid` from `semver` returns it unchanged, or when it is Melian's `unavailable`, and as the fixed withheld sentence otherwise. `semver` 7.8.5, already in the lockfile, is now a pinned dependency of the pipeline, with `@types/semver` 7.8.0 for the root's type checking.

Five tests in `packages/pipeline/test/review-records-withheld.test.ts` failed on 9e26dfd0 for the reported reason, a made-up token exported as the version, and pass after the fix. A pre-release tag can still carry a short run of letters and digits; the decision names that limit.

The coordinator asked for the rule on 2026-11-16. Enola's snapshot ID, receipt and cache key stay named limits for [pull request #524](https://github.com/melian-agent/melian/pull/524).

Mutation proof: `2026-11-16-issue-496-tool-version-mutants.json` lists the commit's 12 mutants. All 11 generated mutants were killed, each by its named test run alone after that test passed unmutated. One mutant survived the first run, a missing version exported as the withheld sentence rather than `null`, and a new test kills it. The twelfth is a string literal the configuration ignores.
