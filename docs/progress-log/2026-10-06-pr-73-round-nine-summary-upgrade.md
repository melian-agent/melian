# Summary-index migration belongs to its stored shape

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round nine, item 3: confirmed. The version 1 summary-index migration was an inline callback, contrary to the stored-shape rule in `AGENTS.md`.

`SummaryIndexState.upgrade` now converts the old task map into the version 2 shape. The document’s migration delegates to it. The class also constructs the initial shape and serialises its fields, following `LensTaskInput` on the decider branch.

Validation: the existing migration test remains unchanged. It reads a version 1 index and verifies that a pending task refunds its old creation charge once before completing. The walkthrough suite and repository gate pass. The gate caught a ledger-record recovery regression from item 1: status reconciliation must retain the published ledger URL while discovery restores a missing ledger record. That recovery now passes without extra writes.
