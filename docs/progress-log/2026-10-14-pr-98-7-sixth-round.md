[Pull request #98](https://github.com/melian-agent/melian/pull/98): fixes from Melian's sixth round (4,013 seconds of wall time). That round read `not reviewed` because `lens.correctness` used up its 3,500,000-token budget, not because of anything in the change.

- The real Stryker test now checks the verdict, not only that Stryker ran. It mutates a well-tested function and a weakly tested one, both inside a `describe`, and expects survivors only in the weak one. Weakening the good test by hand fails it.
- `MutationRun.judges` now has a test showing that a text production file with no changed lines has nothing to judge, and that a file whose name is not UTF-8 does. With either condition mutated, a test fails.

The confirmed `secret-exposure` finding stands, as in round five, and waits for the maintainer.
