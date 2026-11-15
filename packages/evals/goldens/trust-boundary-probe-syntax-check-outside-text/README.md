# trust-boundary-probe-syntax-check-outside-text

A stand-in for [pull request #282](https://github.com/melian-agent/melian/pull/282), "fix(pipeline): a static check stores nothing from files outside the checkout". Before #282, a committed link to an outside `.d.ts`, or a `/// <reference path>` to one, made tsc quote the outside file's text, and Melian stored and published that text in a finding.

The faithful golden would run `staticFindings` from #282's merge base. That module needs 16 other core modules and `typebox`, `yaml` and `typescript`, and a golden can carry neither without about 30,000 copied lines or [issue #322](https://github.com/melian-agent/melian/issues/322)'s overlay and dependency links. The maintainer ruled on [issue #288](https://github.com/melian-agent/melian/issues/288) for this synthetic stand-in, which has the same defect class, until #322 lands.

The head adds `src/syntax-check.mjs`, a small wrapper that runs `node --check` on every module of a checkout and keeps the line Node quotes in each finding's text. The level that probes plans one attack. Its probe builds a checkout whose `src/vendor.mjs` is a link to an outside file that holds a planted token on a line with a syntax error. It then runs the head's `checkFindings` and `render`, and exits 1 because both quote the token.

The rule is `secret-exposure`, at P1: an author reaches a file outside the checkout with realistic input.

The golden's `.melian/lenses/trust-boundary/LENS.golden.md` gives `deep` a probe, since no shipped level probes until the live measurement picks the routes.
