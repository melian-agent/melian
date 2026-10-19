# Thinking routes: plan mutation survivors

[Pull request #157](https://github.com/melian-agent/melian/pull/157) adds direct plan tests for absent effective and committed routes.
They cover removing a protected thinking setting, omitting absent lineage fields, and explaining a retiered lens's model refusal.

Seven exact Stryker replacements fail these tests: optional-chain removal at the two override levels and the refusal message, plus four conditional replacements in lineage and refusal.
Each source was restored and the 85 plan tests passed.
Removing the optional chain from `lineage?.thinking` is equivalent: the outer `outside` condition already requires lineage.

The pass 3 report and appended mutation inventory live in `tmp/m2/scratch-thinking/` in the main checkout.
No production behaviour changes. The implementation plan's status stays unchanged.
