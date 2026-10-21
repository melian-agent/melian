# Documentation refresh, 2026-10-21

Design, guidelines, README and skills now match `main` at c29cbba8 for the work from [pull request #146](https://github.com/melian-agent/melian/pull/146) to [pull request #161](https://github.com/melian-agent/melian/pull/161). Most of that work updated its own text. Six passages had drifted:

- `docs/design.md` and `docs/guidelines/pipeline.md` called the verdict document version 10. It is version 12: 11 added each tier's reasoning level to the plan, and 12 the override lineage ([pull request #157](https://github.com/melian-agent/melian/pull/157)).
- The design's `melian findings` entry lacked `--rounds` and `--round <id>`, and its `melian doctor` entry lacked the reasoning level ([pull request #152](https://github.com/melian-agent/melian/pull/152), [pull request #157](https://github.com/melian-agent/melian/pull/157)).
- The design's Rounds paragraph said step 23 built the whole rule. Only the first of four pull requests has landed.
- The design's walkthrough text did not say that Melian's committed light route turns the walkthrough on ([pull request #159](https://github.com/melian-agent/melian/pull/159)).
- The design and pipeline guideline read an observed opening effort as the level used. For managed-effort Anthropic models the provider-reported level is the authority.
- The README did not mention reasoning levels, and the three skills did not mention `melian findings --rounds` or `--round`, or doctor's reasoning level. `packages/cli/test/skills.test.ts` now expects both options.

`AGENTS.md` gains eight learnings from the reasoning, rounds and supersession passes.
