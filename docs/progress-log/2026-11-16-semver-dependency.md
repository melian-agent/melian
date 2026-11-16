# The semver dependency, before [issue #496](https://github.com/melian-agent/melian/issues/496)

[Pull request #530](https://github.com/melian-agent/melian/pull/530) checks a static tool's version with semver's `valid`, so it needs `semver` 7.8.5 in `packages/pipeline` and `@types/semver` 7.8.0 at the root. This pull request adds those two and nothing else.

It lands first because the `melian round` workflow type-checks a head with the default branch's `node_modules`. Until `main` has `@types/semver`, every round on #530 blocks on tsc's TS7016 at the import. The coordinator chose the split on 2026-11-16; it is the coordinator's answer, not a ruling.

`semver` 7.8.5 was already in the lockfile as another package's dependency, so the lockfile adds only `@types/semver` and the two declarations.
