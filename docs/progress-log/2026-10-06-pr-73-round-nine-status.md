# Publication repairs unrecorded ledger-refusal statuses

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round nine, item 1: confirmed. Both status skip guards trusted local records. An error posted before a crash could leave the stored success status intact, so a successful retry left GitHub showing error.

Publication now reads the provider before each status skip. It compares the provider’s state and ledger URL alongside the recorded description, then records the reconciled status. Both the first status and the ledger link use that path.

Validation: a fake holds a ledger-refusal error while the durable record still holds success. The regression fails before the fix and ends with success afterwards. Publication and crash recovery suites pass.
