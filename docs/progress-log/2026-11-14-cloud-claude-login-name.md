# A cloud session carries the Claude login under a name of Melian's

Until 2026-11-14 no cloud builder had a Claude login: five sessions checked for `CLAUDE_CODE_OAUTH_TOKEN` and found it unset, though the environment set it. A cloud session removes that name from its shell, since it is Claude Code's own. So a builder's review from its own build ran its verifier on a Codex model, and the final own-build round of every pull request went to the coordinator's host.

The maintainer set the login as `MELIAN_ANTHROPIC_OAUTH_TOKEN` on 2026-11-14. A test session confirmed that the new name reaches the shell and the old one does not, and that `melian doctor` resolves every committed route once the login is passed as `ANTHROPIC_OAUTH_TOKEN` for that command and the Codex token is named in a scratch `secrets.yaml`.

`AGENTS.md`'s "Working in a cloud session" now names the variable and the command, and notes that the container's npm 10 needs the upgrade the first learning describes.

Guidance only: no code or test changes.
