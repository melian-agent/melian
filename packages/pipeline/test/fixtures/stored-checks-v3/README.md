# Recorded version-3 checks and version-8 verdicts

`review.json` holds the `melian.checks` and `melian.verdicts` snapshots that the review code wrote at `69475b44`, `main` before step 22 let a mutation record be `provisional`. The checks document was version 3 and the verdicts document version 8. This is recorded output, not a hand-built old shape.

The recording ran in a checkout of that commit, as a Vitest test in `packages/pipeline/test/`. It built a repository with `createRepository()` and two commits: a base whose `melian.yaml` ran the guardrails alone with one `forbidden-patterns` rule, `todo`, and a head that added a `TODO` line to `notes.txt`. It ran `reviewChangeset` on memory storage with the fake model, no lens and the checkout set, then read both documents through `harness.snapshot` and wrote them with the revision key and the verdict's status. No provider, credential or environment file was read.
