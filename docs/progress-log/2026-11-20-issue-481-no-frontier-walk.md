# Issue #481: the reader tests every round outside a dismissal's frontier

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575). The coordinator directed on 2026-11-20 that this land in this pull request.

## The defect

`roundsSince` walked back from a dismissal's `frontier` along each round's `before`, and counted every round it reached as held. In a store synced in part, a frontier can name a round M without the round U of another revision that M follows, since the writer's listing never held U. Once U reached the set, the walk counted it as held and kept the dismissal, which U ends by the maintainer's ruling that a round at another revision ends a shared dismissal.

The test "ends a dismissal at a round of another revision its writer never met, though a round of its frontier names it" failed on `a4a270eca`:

```
× ends a dismissal at a round of another revision its writer never met, though a round of its frontier names it
-     "new",
+     "dismissed",
Tests  1 failed | 100 skipped (101)
```

## The fix

`f68f14ca9` drops the walk. The reader tests every round of the changeset in the set that the frontier does not name. `before` now decides one thing: a round since that names a round neither the set nor the frontier holds leaves the finding live. That check stays, so the field stays read, and no issue removes it from the stored shape.

Of the four tests that handed the reader a frontier naming only its head, two now read live. The other two, which also prove the reader remembers no hunk a held round cited, read live under that frontier and dismissed under a full one, as `melian dismiss` writes. The property test in `review-records-export.test.ts` passes with seeds 9, 112 and 302.

## Mutants

The commit only deletes lines, so `melian mutants list` lists no mutant for it. Stryker's instrumenter gives 30 mutants over the whole of `roundsSince`. Each ran by hand: a failing test was found in `recorded-round.test.ts` or `review-records-export.test.ts`, then that test ran alone, passing unmutated and failing mutated.

All 30 are killed, at `f68f14ca9`. [The run log](2026-11-20-issue-481-no-frontier-walk-runs.json) records each mutant, the text it replaced, its named test, and both runs.
