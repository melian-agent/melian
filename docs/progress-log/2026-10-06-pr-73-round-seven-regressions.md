# Nonce and summary input bounds have regressions

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round seven, item 5: confirmed missing coverage. The production protections already worked.

The agent-prompt test embeds its nonce in a path and twice in the explanation. The summariser test changes 20 large files and checks nine bounded blocks totalling 100,000 characters, with an omission note for unread files.

Mutation checks fail when nonce replacement becomes single-occurrence replacement, and when the remaining-budget decrement is removed. Production code is restored. Both affected test files pass, 22 tests.
