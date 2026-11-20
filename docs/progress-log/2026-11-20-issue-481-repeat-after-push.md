# Issue #481: a dismissal made again after a push is shared at the pushed revision

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575), from the review of record at `cdcda0e4c`.

## What changed

The review of record's R1: after a push ends a shared dismissal, `melian findings --records` tells the maintainer to dismiss again with `--records`. With the same reason, `dismissFinding` counted the repeat as no change, since it compared the dismisser, the reason, the trigger and the run, but not the revision. The frozen sighting stayed at the old revision, `ReviewRecords.made` found the old record in the store, and the finding stayed live in shared reads for good. `93cbc502d` counts a repeat at another revision as a new dismissal, so its record names the pushed revision and supersedes the old one.

R2: `758415a3d` corrects the pipeline guideline, which said no static dismissal is shared and that a host's reopen reaches the reader through the reopen rule.

## Failing test first

`review-records-export.test.ts`'s "shares a dismissal made again with the same reason after a push, at the pushed revision" follows the reviewer's probe. Against `cdcda0e4c`:

```
× shares a dismissal made again with the same reason after a push, at the pushed revision
AssertionError: expected { dismissals: [], ended: [ { …(5) } ] } to deeply equal { …(2) }
Tests  1 failed | 50 skipped (51)
```

It passes after `93cbc502d`.

## Mutants

[The inventory](2026-11-20-issue-481-repeat-after-push-mutants.json), from `melian mutants list cdcda0e4c...HEAD` at `758415a3d`, has 13 generated rows, all on the repeat test, and one ignored. Each ran at `93cbc502d` against its named test alone, which passed unmutated and failed mutated. Two survived the candidate files: `severity === undefined` forced false, and `dismissedSighting?.run === run` forced true. Both operands are older than this pass. `e28a5665d` adds a test for each in `findings.test.ts`, and each kills its mutant alone. All 13 are killed.
