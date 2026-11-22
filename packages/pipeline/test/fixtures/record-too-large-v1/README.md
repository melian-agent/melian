# Records a build wrote before a shared check record named `recordTooLarge`

`recorded.json` holds the records one range review exported, written by the branch of [issue #626](https://github.com/melian-agent/melian/issues/626) at `6a70c41fc` with fake models. The host handed the review a guardrails check that failed with `RecordError` `recordTooLarge`, as `runCheck` records a check whose findings cannot fit the store, taken from `SightingBudget`'s own throw. That build's `recordCodes` did not list the code, so the guardrails record carries `unexpected`. No record was assembled by hand.

To reproduce, extract `git archive 6a70c41fc` to an isolated source directory, install that tree's locked dependencies, and copy `capture.mjs` to its root. Run Node 24 with `--conditions=@melian-agent/source`, followed by the script path, an absolute output directory and the commit.
