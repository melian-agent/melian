# Documentation refresh, 2026-10-21

Design, guidelines, README and skills now match `main` at c29cbba8 for the work from [pull request #146](https://github.com/melian-agent/melian/pull/146) to [pull request #161](https://github.com/melian-agent/melian/pull/161). Most of that work updated its own text. Six passages had drifted:

- `docs/design.md` and `docs/guidelines/pipeline.md` called the verdict document version 10. It is version 12: 11 added each tier's reasoning level to the plan, and 12 the override lineage ([pull request #157](https://github.com/melian-agent/melian/pull/157)).
- The design's `melian findings` entry lacked `--rounds` and `--round <id>`, and its `melian doctor` entry lacked the reasoning level ([pull request #152](https://github.com/melian-agent/melian/pull/152), [pull request #157](https://github.com/melian-agent/melian/pull/157)).
- The design's Rounds paragraph said step 23 built the whole rule. Only the first of four pull requests has landed.
- The design's walkthrough text did not say that Melian's committed light route turns the walkthrough on ([pull request #159](https://github.com/melian-agent/melian/pull/159)).
- The design and pipeline guideline read an observed opening effort as the level used. For managed-effort Anthropic models the provider-reported level is the authority.
- The README did not mention reasoning levels, and the three skills did not mention `melian findings --rounds` or `--round`, or doctor's reasoning level. `packages/cli/test/skills.test.ts` now expects both options.

`AGENTS.md` gains eight learnings from the reasoning, rounds and supersession passes.

The maintainer took the coordinator's recommendation on questions 1, 3, 4, 5, 6, 7, 9, 14, 15 and 18 of `docs/readiness-check-questions.md` on 2026-10-21. Each now carries its answer. Plan step 10 notes that the readiness check was held and the rehearsal is next.

[The readiness rulings](../decisions/2026-10-21-readiness-check-rulings.md) record the ten answers as a decision that amends the shadow-retirement window and the outcome task. The readiness questions are struck, plan step 25 and the design carry the on-demand rule, and the Rounds paragraph says question 3 is settled. For models whose adapter reports managed effort, pi-ai sent `output_config.effort: high` in the opening body and set the requested level in a mid-conversation system message on Sonnet and Opus 5.5; the AGENTS.md learning now states this by capability.
