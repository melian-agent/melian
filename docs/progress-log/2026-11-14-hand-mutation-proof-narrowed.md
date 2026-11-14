# The hand mutation proof is narrowed to trust and durability code

The maintainer ruled on 2026-11-14, in the coordinator's session, that builders owe the hand mutation inventory only for changed code that guards trust or durability. [The decision](../decisions/2026-11-14-hand-mutation-proof-only-for-trust-and-durability.md) records the rule and the figures behind it.

`AGENTS.md` carries it in Validation, Briefs and Converging; the plan-step issue template and the review-of-record brief follow. The inventory stays the enumerator's whole output. Until [issue #418](https://github.com/melian-agent/melian/issues/418) lets the sampler read which files owe a claim, a pull request that owes an inventory claims every row, so the review of record's `--sample` runs unchanged.

Guidance only: no code or test changes.
