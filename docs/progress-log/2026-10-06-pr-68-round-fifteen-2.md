Removed the CLI comment narrating the default-source branch from the fifteenth Melian round on [pull request #68](https://github.com/melian-agent/melian/pull/68). The expression shows that a pull request with no explicit sources uses GitHub. The same file’s help text already names CodeRabbit as that source.

The comment adds no outside constraint or trap, so it conflicts with `AGENTS.md`’s no-restatement rule. The fallback expression, behaviour and design decisions stay unchanged.
