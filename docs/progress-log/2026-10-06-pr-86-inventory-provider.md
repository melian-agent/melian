# Prove provider permission and author branches

[Pull request #86](https://github.com/melian-agent/melian/pull/86)’s inventory now checks all six repository permissions through Octokit’s fake transport. Null and absent author payloads must not invent a login. Mutations also exercise unknown roles and permission-read refusal.
