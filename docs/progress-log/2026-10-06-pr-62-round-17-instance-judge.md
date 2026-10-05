# Escalation fixture calls the instance

The seventeenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) noted that the escalation refusal fixture detached `plan.judge` with `bind`.

The fixture now keeps an unchanged plan instance beside the spied plan. Its mock calls `original.judge(...)` for cases outside the injected refusal. The test still checks that a refused finished model fails the escalated record.
