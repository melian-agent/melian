# 2026-10-22: merge-group intake uses a loading factory

The status object in [pull request #168](https://github.com/melian-agent/melian/pull/168) reads an event but holds no resource to close. Its factory is now `MergeGroupStatus.load`, following the repository's factory convention. The command calls the object's factory and `post` method directly, removing a helper with one call site.

All 90 command tests pass after the rename. The change adds no guard, branch or bound. The retained mutation proofs still exercise the same validation and publication paths.
