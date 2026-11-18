# Lenses skip mutation inventories

The maintainer ruled on 2026-11-18, in the coordinator session, that Melian's own lenses stop being shown the mutation inventories, `docs/progress-log/*.json`. On [pull request #532](https://github.com/melian-agent/melian/pull/532) they were 9,256 of 11,500 added lines, each lens's first request was about 250,000 tokens, and the round read not reviewed. [The decision](../decisions/2026-11-18-lenses-are-not-shown-mutation-inventories.md) records the rule and its limit: no lens reviews an inventory's claims, and only the review of record's sample checks them.

The root `melian.yaml` adds `"!docs/progress-log/*.json"` to the `paths` of its eight lens entries. No budget, tier, level or route changed. `packages/core/test/lens.test.ts` gained a test that Melian's lenses select an inventory for none of them and a `.md` entry, a nested `.json` file and a `.json` file elsewhere for the design lens. It failed before the change and passes after. The same file's pinned lens versions changed, since a lens's version hashes its paths.

The change guards no trust or durability code, so no mutant was run by hand.
