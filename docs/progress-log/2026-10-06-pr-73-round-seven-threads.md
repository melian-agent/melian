# Old replies still owe thread resolution

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round seven, item 2: confirmed. Recovery recorded a separate signed reply and skipped GraphQL resolution. Milestone 1 posted that reply but left the thread open.

Recovery now counts the reply as posted and resolves the thread before recording the action. Replays skip threads already resolved. The regression starts with an old reply and an open thread, then checks resolution with no edit or new reply.

Validation: ledger, publication crash, dismissal and findings test files pass.
