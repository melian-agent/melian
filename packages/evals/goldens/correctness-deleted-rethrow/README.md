# correctness-deleted-rethrow

Seeded from A1 and E3 of the [comparison record](../../comparisons/2026-10-05-pr-42.md) for [pull request #42](https://github.com/melian-agent/melian/pull/42). A1 found that `correctness` handed deleted error paths to `removed-behaviour` even in the `standard` tier, where `removed-behaviour` does not run. E3 found the hole reopened through the rule's wording: once `unhandled-error` covered only a swallow the change wrote, a `pre-push` review of a deleted rethrow reported nothing. A test pins the rendered instructions; this golden pins the finding.

The change rewrites the log line in an existing `catch` and drops its `throw error;`, so a failed migration is recorded as applied and startup goes on. Its `melian.golden.yaml` routes the `pull-request` stage to `standard`, so `correctness` runs alone, with no hand-off rendered, and must report the swallow as `unhandled-error` itself.

It differs from its neighbours on purpose. `correctness-deleted-guard` is a pure deletion, so its finding is `affected` through a `cause` at the base; here the change writes a line in the defect's hunk, so the finding is `introduced`. In `removed-behaviour-dropped-error-path` the swallow returns a value that reads as absence; here it sends the caller on to the next step.
