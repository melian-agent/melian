# Recorded version-6 state

`review.json` holds the `melian.findings` and `melian.verdicts` snapshots that the review code wrote at `72ec6d41`, before step 17, "The verifier lowers severity and sets scope". Both document definitions were version 6. This is recorded output, not a hand-built old shape.

The recording ran in a checkout of that commit, as a Vitest test in `packages/pipeline/test/`. It built `crashRepository()`, loaded the built-in correctness lens, and scripted it to report `crashFinding`. It scripted the verifier to confirm the claim with a correction. It ran `reviewChangeset` on memory storage with the fake model, then read both documents through `harness.snapshot` and wrote them with the revision key. No provider, credential or environment file was read.

The verification record therefore has no answers, no evidence, no lowering and no re-scope, and the verdict has no `preExistingImportant`. The reopen test in `findings.test.ts` writes these values through version-6 document tokens to SQLite, closes it, and reads and writes them through the current definitions.
