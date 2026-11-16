# trust-boundary-probe-syntax-check-outside-text-clean

The clean twin of `trust-boundary-probe-syntax-check-outside-text`, a synthetic stand-in for [pull request #282](https://github.com/melian-agent/melian/pull/282) until [issue #322](https://github.com/melian-agent/melian/issues/322) lets a golden carry #282's own code. That golden's README says why.

The head's `src/syntax-check.mjs` keeps each finding's rule and place and replaces Node's text with a fixed sentence, as #282 does for Biome and tsc. The same probe passes, so `report_finding` refuses the finding and the review is clean.

It also reads the rule only from Node's error names after the blank line and the place only after the path it gave Node, checks `.cjs`, and escapes control characters in file names. The defect twin's README says where each gap was found; they are fixed in both twins so this one is clean, and none is an expectation. It still follows a committed link, as #282's fix does.

The golden's `.melian/lenses/trust-boundary/LENS.golden.md` gives `deep` a probe, since no shipped level probes until the live measurement picks the routes.
