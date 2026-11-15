# trust-boundary-probe-claim-lost-release-clean

From [pull request #274](https://github.com/melian-agent/melian/pull/274), "Swap claim labels in a workflow". Codex's adversarial review and the Opus review of record found the lost release at `fcb25afa` by running the workflow's script against a timeline in which a builder's `Released:` lands between a claim run's read and its writes: the next run reads the claim run's own `unlabeled status: ready` as a hand removal and writes nothing.

The clean twin's head is `main`'s `claim.yml`, after the fix. The same probe passes, so `report_finding` refuses the finding and the review is clean.

The rule is `fail-open`, as the maintainer ruled on 2026-11-07 in [issue #288](https://github.com/melian-agent/melian/issues/288). The status label is the check builders trust to tell them an issue is free. The workflow's own `unlabeled` event is input it did not expect, and it makes the workflow skip the label change it owed, as if the timeline asked for none, so the issue stays held after a writer released it. No trust-boundary rule names an interleaving, and `fail-open` is the one whose outcome this is.

The golden's `.melian/lenses/trust-boundary/LENS.golden.md` gives `deep` a probe, since no shipped level probes until the live measurement picks the routes.
