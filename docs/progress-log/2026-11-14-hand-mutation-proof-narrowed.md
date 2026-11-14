# The hand mutation proof is narrowed to trust and durability code

The maintainer ruled on 2026-11-14, in the coordinator's session, that builders owe the hand mutation inventory only for changed code that guards trust or durability. [The decision](../decisions/2026-11-14-hand-mutation-proof-only-for-trust-and-durability.md) records the rule and the figures behind it.

`AGENTS.md` carries it in Validation, Briefs and Converging; the plan-step issue template and the review-of-record brief follow. Until [issue #418](https://github.com/melian-agent/melian/issues/418) gives `scripts/enumerate-mutants.mjs` a path filter, a reviewer of record selects rows by a fixed rule over their IDs, since `--sample` refuses an inventory that holds only some files' rows.

Guidance only: no code or test changes.
