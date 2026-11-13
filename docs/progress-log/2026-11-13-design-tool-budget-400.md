# The design lens's tool budget is 400, and the conventions lens's findings budget is 24

The maintainer ruled on 2026-11-13, in the coordinator's session, to raise `lens.design`'s committed tool budget. The host round on [pull request #296](https://github.com/melian-agent/melian/pull/296) at `e1280f1a` read not reviewed: the design lens ended at its 250 tool calls after 2,307,215 of its 3,000,000 tokens. It is now 400 tool calls and 5,000,000 tokens, so the token budget does not end the lens where the tool budget did.

The same round ended `lens.conventions` at its findings budget of 16. Raising that to 24 is the coordinator's choice, not a ruling: a round with either lens cut reads not reviewed, and 24 is the figure the Learnings in `AGENTS.md` name for a record round.

A pull request's round reads lens budgets from its base, so no local override can raise them for one round. Policy only; no code changed.
