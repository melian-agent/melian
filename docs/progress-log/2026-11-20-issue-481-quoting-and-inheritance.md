# Issue #481: a quoted dismiss-again command, and inheritance stated as a cost

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575). This pass took the coordinator's three items from the host round at `cdcda0e4c`.

## The dismiss-again command is quoted

The line `melian findings --records` prints for a dismissal that a push ended named the target and the store unquoted. A `#12` target began a shell comment, and a store path with a space split in two. `20c1a7e8b` quotes both with `shellQuote`, as every other suggested command does.

The test in `cli.test.ts` reviews `#12...HEAD`, with a store under `shared records`. Against the head before the fix it failed:

```
× quotes the target and the store in the command that dismisses a finding again
Received: "... dismiss it again: melian dismiss #12...HEAD 8989ad96980aceae --reason <text> --records dir:/tmp/melian-cli-cC1dFm/shared records"
Tests  1 failed | 99 skipped (100)
```

After the fix it passes. Removing either `shellQuote` call, each run alone against that test, makes it fail again.

## Inheritance in a shared reader is a stated cost

A reader of shared records computes no inheritance, so a restated finding that the host passes as inherited reads live there. The one-revision decision now amends the restatement decision and the shared-record decision's rule 9 for that, and says what it costs: a restated finding needs a shared dismissal of its own. A new test in `restatement.test.ts` pins both sides: the host reads the restatement as inherited from its root, and `RecordedRound` reads it new and blocking.

Inheritance at one revision could not come from the verification record alone. The host also needs the defect merge, the severity fence and the floors, and the verifier's `same` is only one of its conditions.

## The store's failure window, under the new reader

No code changed. The one-revision decision now restates the written-once decision's gap: when a record reaches the store and the host records nothing, a reader of a round at the dismissed revision reads the finding dismissed, while the writing host blocks until `melian dismiss` runs again. A round at another revision ends it for the reader too.
