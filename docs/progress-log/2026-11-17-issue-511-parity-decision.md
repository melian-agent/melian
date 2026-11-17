# Issue #511: the parity ruling gets its decision file

The Actions round on 265bb34e raised a P2 acknowledge from `lens.design`, `criterion-selection-bias`, ID `7b9e412376621ecb`, at `goldens.ts:655-656`. It read `alternativeRules` and the claim golden's dropped `source` as a golden loosened after one live run. [The evals guideline](../guidelines/evals.md) says goldens are never loosened, and the maintainer's ruling of 2026-11-16, that parity is with the review of record whichever lens finds the defect, sat in the guideline with no decision file.

[The parity decision](../decisions/2026-11-16-parity-is-with-the-review-of-record.md) records the ruling and amends the restored design-lens clause "without loosening the goldens". An expectation names no `source`, and lists `alternativeRules`, only where the review of record would accept that finding as the defect. The ruling sets this, never one live run, and a golden is still never loosened to lift a score. The guideline's bar and its live-run step say the same and link it, and `docs/design.md`'s evals section names it. No code changes, so no mutants.

The coordinator chose this over acknowledging the finding unchanged.

The decision quotes the maintainer's words as written. Earlier text in this pull request put the coordinator's paraphrase of them in quotation marks; the guideline and the golden's README now give it as a paraphrase.
