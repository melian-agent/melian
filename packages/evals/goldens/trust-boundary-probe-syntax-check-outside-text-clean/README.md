# trust-boundary-probe-syntax-check-outside-text-clean

The clean twin of `trust-boundary-probe-syntax-check-outside-text`, a synthetic stand-in for [pull request #282](https://github.com/melian-agent/melian/pull/282) until [issue #322](https://github.com/melian-agent/melian/issues/322) lets a golden carry #282's own code. That golden's README says why.

The head's `src/syntax-check.mjs` keeps each finding's rule and place and replaces Node's text with a fixed sentence, as #282 does for Biome and tsc. The same probe passes, so `report_finding` refuses the finding and the review is clean.

The golden's `.melian/lenses/trust-boundary/LENS.golden.md` gives `deep` a probe, since no shipped level probes until the live measurement picks the routes.
