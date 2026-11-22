# A route whose fallback names a level names its own

[Issue #489](https://github.com/melian-agent/melian/issues/489). The maintainer ruled on 2026-11-17, in the coordinator's session, that a route must name its own thinking level whenever any of its fallbacks names one, so a model that names no level always runs at the route's, and nothing is inherited from a fallback promoted past a model no credential reaches.

- Loading refuses a route written the other way, naming the file that wrote the fallbacks and the key to set. It checks committed policy alone as well as the merged routes, since a round on Actions reads no preference file.
- `routeInOrder` throws for a route that names no level while one of its models names one, so a route that reached it without loading fails closed. The plan's set of inherited levels and the policy guard's repeat loop are gone: once a route names its level, the level a model runs at does not depend on which models are dropped.
- Doctor's warning about a bare fallback at `off`, `minimal` or `low` stays, by the coordinator's answer of 2026-11-17. Builder agent's choice: where a fallback promoted to first runs at a level of its own, the warning now names the committed route's model as the one the level was chosen for, since naming the promoted fallback misreported. The level-readers table's two "at low" shapes failed against the old text and pass now.
- The level-readers and route-shapes tables dropped the four shapes this rule refuses and gained a shape at `high` with a promoted fallback at `low`, and one with no level anywhere.
- Melian's own `melian.yaml` loads: every route with a levelled fallback names its own level. The goldens' policies load in the suite.

Mutants, over `805122d2...HEAD` in `config.ts`, `models.ts` and `plan.ts`: [the inventory](2026-11-17-issue-489-route-level-mutants.json) has 78 rows, 8 ignored, 68 killed by a named test and 2 equivalent. The first run killed 60 of 70. Five tests then killed 7 of the 8 non-equivalent survivors, and asserting the whole warning list killed the last. Each kill passed its named test alone on the unmutated head first.
