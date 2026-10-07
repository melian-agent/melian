# Prove policy schema boundaries

[Pull request #86](https://github.com/melian-agent/melian/pull/86)’s source inventory found gaps at valid recall endpoints, the one-pull-request minimum and empty policy objects. New tests preserve defaults and reject unknown keys in trust, comparison and retirement objects. Mutations exercise each new schema guard and root-only refusal.
