# Issue 489: Codex's sixth review, a refused check's lineage and the live eval's fallback

Codex's adversarial review of the branch, after #532's latest head merged in, found two defects. Each fix started with a failing test.

## A refused check carried a level no model answered at

A lens or verifier the plan refused took its lineage from the plan, and the plan names the level the first model it would have run on answers at. A refused check is a check no record holds, so a review with a record store writes it into the account. The account is still version 1, which holds no `answeredAt`, and the export threw. A committed verifier whose fallback names `medium`, under `acceptOverridden: false`, a local file that raises the level, and a first model without credentials, failed the review with the account's error instead of `verifierFailed`.

Two tests in `packages/pipeline/test/verification.test.ts` reproduce it, one for the verifier and one for a lens on the heavy tier. Both failed on 57e3f814 with `lineage names the level its model answered at, which an account cannot hold`. After the fix both pass, and the account's filled entry names the model and the level change but no `answeredAt`.

The fix, b59f1e07 and the refactor b3854be3 after it, drops `answeredAt` where `review.ts` builds a check that asked no model, at the refused lens and the refused verifier. Core still names the level in doctor's planned lines, where it is the level a model will run at. Versioning the account to hold `answeredAt` stays the follow-up after pull request #525.

`review.ts` writes what the account stores, so the fix guards durability. `melian mutants list` gives its 12 mutants, in [the inventory](2026-11-17-issue-489-refused-lineage-mutants.json). Each was run by hand against its named test alone, which passed unmutated first: 12 of 12 killed at b3854be3. Three needed a refused check with no lineage, or no plan, and fell to existing tests in `plan.test.ts` and `verification.test.ts`. A fourth, a second check of a missing lineage, survived every test, so the refactor folded the two checks into one.

## The live eval built a route with no level for a levelled fallback

`MELIAN_EVAL_FALLBACK=provider/model-id@level` gave every tier `MELIAN_EVAL_MODEL` fills a fallback with a level and the route none, which the pipeline refuses. Each golden printed no score, and the script exited 1. Two cases in `packages/evals/test/thinking.test.ts` reproduce it, with no `MELIAN_EVAL_THINKING` and with heavy left out of it. Both exited 1 on 57e3f814, where they expect 2 and the refusal. The fix, fdee983a, refuses at start unless `MELIAN_EVAL_THINKING` names light, medium and heavy, and the evals guideline says so.
