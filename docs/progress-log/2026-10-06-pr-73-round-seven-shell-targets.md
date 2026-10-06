# Agent dismissal commands preserve their shell target

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round seven, item 4: confirmed by a POSIX shell regression. A target with a backtick became a different argument because a single-quoted shell string retained the display escape literally. A single quote already survived correctly.

Targets now use shell quoting directly. Embedded single quotes close the string, emit an escaped quote and reopen it. Backticks pass unchanged. Targets holding a control character or the boundary nonce get no dismissal command, since escaping either would change the ref.

Validation: agent-prompt and adjudication test files pass. The shell tests replace Melian with a local function that prints its target; they invoke no CLI, git or provider.
