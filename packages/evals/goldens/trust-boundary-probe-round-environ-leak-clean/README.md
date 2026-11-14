# trust-boundary-probe-round-environ-leak-clean

From [pull request #275](https://github.com/melian-agent/melian/pull/275), "ci: let a builder start its own Melian round in Actions". At `292e5fed`, a head's `biome.json` that extended `/proc/<pid>/environ` put the round's logins in Biome's parse error, and the round comment and the run's artefact printed it.

The clean twin's head is `main`'s `melian-round.yml`, `round.mjs` and `round-comment.mjs` as #275 merged them at `fc0d1755`, with core's `render.ts` and `emoji.ts` they import. The comment renders a check that did not run by name and status alone. The same probe passes, so `report_finding` refuses the finding and the review is clean.

The golden's `.melian/lenses/trust-boundary/LENS.golden.md` gives `deep` a probe, since no shipped level probes until the live measurement picks the routes.
