# trust-boundary-probe-round-environ-leak

From [pull request #275](https://github.com/melian-agent/melian/pull/275), "ci: let a builder start its own Melian round in Actions". Before its third fix pass, at `292e5fed`, a head's `biome.json` could extend `/proc/<pid>/environ`, the round step's shell, which still holds the round's logins after `unset`. Biome's parse error quotes that file. `scripts/round.mjs` printed each check that did not run with its error into the round comment, and the workflow uploaded the raw verdict and Melian's output as the run's artefact, so both carried the logins out of the job.

The head is `292e5fed`'s `melian-round.yml`, `round.mjs` and `round-comment.mjs`, with core's `render.ts` and `emoji.ts` they import. The level that probes plans one attack on the comment. Its probe writes a verdict whose `static.biome` error quotes a planted login, runs `round-comment.mjs` as the workflow's report step does, and exits 1 because the comment quotes it.

The rule is `secret-exposure`, at P1: an author reaches a secret with realistic input. The probe drives the comment alone; the artefact needs a runner, and the finding names the upload's path as context.

The golden's `.melian/lenses/trust-boundary/LENS.golden.md` gives `deep` a probe, since no shipped level probes until the live measurement picks the routes.
