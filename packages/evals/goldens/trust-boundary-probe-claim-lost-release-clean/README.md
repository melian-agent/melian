# trust-boundary-probe-claim-lost-release-clean

From [pull request #274](https://github.com/melian-agent/melian/pull/274), "Swap claim labels in a workflow". Codex's adversarial review and the Opus review of record found the lost release at `fcb25afa` by running the workflow's script against a timeline in which a builder's `Released:` lands between a claim run's read and its writes: the next run reads the claim run's own `unlabeled status: ready` as a hand removal and writes nothing.

The clean twin's head is `main`'s `claim.yml`, after the fix. The same probe passes, so `report_finding` refuses the finding and the review is clean.

The rule is `fail-open`: the label is what tells builders an issue is free, and the workflow's own event reads as a hand edit, so the gate reads clean when it should not. The defect is an interleaving rather than a hostile input, which the maintainer listed among this week's probes in [issue #288](https://github.com/melian-agent/melian/issues/288).
