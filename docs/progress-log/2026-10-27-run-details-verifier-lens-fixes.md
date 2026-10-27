# Run details: verifier usage and lens variants

Fix pass 3 on [issue #213](https://github.com/melian-agent/melian/issues/213#issuecomment-6431755745), for [pull request #221](https://github.com/melian-agent/melian/pull/221).

`61851eb9` marks reconstructed verifier rows as usage incomplete. The `ran` and `ended` regressions both failed with `usageIncomplete: true` missing, then passed. `run-check-outcomes.test.ts` and `run-details.test.ts` passed all eight tests.

`e0befe8e` records each lens's version on its check. That version includes its folder. Telemetry and route judgement match that identity. A root correctness beside a refused services/pay variant first rendered only `failed`, instead of `ran, failed`. The regression now passes. Exact assertions include the new version field; their existing outcomes stay unchanged.

The follow-up tests cover legacy unversioned records, different levels, separate refusal lineage and one row per deterministic check. The mutation probes drove those assertions. The [inventory](2026-10-27-run-details-verifier-lens-mutants.json) preserves all 52 identities, with no omissions, the scratch runner, named failing tests and output excerpts. Every mutant ran by hand: 47 killed and five equivalent. The equivalent mutants also ran; each has a reason.

Only targeted files ran in the sandbox. The host must run the whole pipeline and CLI suites and `npm run check`.
