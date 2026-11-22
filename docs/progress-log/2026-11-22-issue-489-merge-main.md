# Issue #489: main merged after lens task 8

[Issue #489](https://github.com/melian-agent/melian/issues/489), [pull request #536](https://github.com/melian-agent/melian/pull/536).

Builder agent: merged `main` at `f3ab9dc7`, after [pull request #532](https://github.com/melian-agent/melian/pull/532) took lens task version 8. The lens task is now version 9, migrating 8 and 7; the verification task 6, over main's 5; the verdict document 16, over main's 15. `npm run code-hashes` regenerated `packages/pipeline/src/code-hashes.ts`.

Main's stricter record schemas refuse the records main wrote at `8d4190a2`, whose outcomes held reason text, so `test/fixtures/lineage-v1-main/` was recorded again by main at `f3ab9dc7` with its own `capture.mjs`. An account is version 2 on main and still keeps a lineage without `answeredAt`, so the pipeline guideline and the comment in `review-records.ts` no longer call it version 1.
