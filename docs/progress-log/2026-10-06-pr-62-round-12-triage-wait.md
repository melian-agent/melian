The twelfth review of [pull request #62](https://github.com/melian-agent/melian/pull/62) confirmed that waiting for triage resumed lenses from an earlier selection. A SQLite regression parks two lens requests, reopens with a held decider, and observes both models being asked before triage answers.

The decision commit now removes the live lens task from the index. The sweep aborts it before waiting. Stored decisions return without starting the scheduler. The regression asserts zero model requests during triage, an aborted previous task, and one replacement correctness run at quick afterwards.

Pi Durable refuses `tx.task` after `tx.createTask` has written a table. Read both task records before creating the replacement in the commit.
