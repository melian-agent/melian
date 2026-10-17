# Learnings from the mutation rounds

[Pull request #137](https://github.com/melian-agent/melian/pull/137). Five entries in `AGENTS.md`, one commit each, from the rounds on [pull request #131](https://github.com/melian-agent/melian/pull/131) and [pull request #135](https://github.com/melian-agent/melian/pull/135). A finding ID names a line, not a mutant. A hand inventory is not proof, so the mutation check runs alone before the first full round. Parallel work on one stored shape collides on its version. A migration over several versions needs a reopen test for each. Dismissals belong under the round's own overrides.

Audited every `migrate:` in `packages/*/src`. The adjudication task, the check task and the review index accept more than one older version without reading `fromVersion`. None is shown to be wrong. No code changed, and no decision or plan status changed.
