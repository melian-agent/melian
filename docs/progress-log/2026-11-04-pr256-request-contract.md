# Assert the whole request for all three membership operations

For [pull request #256](https://github.com/melian-agent/melian/pull/256), the paginated membership test now compares every recorded request to a complete expected request. That covers the query text and the variables, for `MelianRoundCommits`, `MelianRoundPushes` and `MelianRoundAssociations`.

## The repeated class

Two consecutive reviews found a new instance of one class: the recorded GitHub fake answers by operation name and cursor, so a query that asks the wrong question still gets a correct answer.

1. The commit query selected `id` where the reader needs `oid`. [The previous entry](2026-11-04-pr256-commit-query-assertion.md) added one substring check.
2. Finding `d88cee71`: the force-push connection could lose `after: $after` while the fake still advanced by variables. The native review of record confirmed it.

AGENTS.md says to [escalate a class, not an instance](../../AGENTS.md#converging). The native review did, and attacked it with a complete independently expected request contract. It found 12 of 16 query and binding variants surviving the tracked tests.

## Existing authority, no new policy

[The GitHub guideline](../guidelines/github.md#tests) already says: assert every field the reader uses, including nested fields; assert `owner`, `name` and `number` on every page; assert the argument bindings. [AGENTS.md](../../AGENTS.md#validation) says a fake answers only what the request asks. The native verdict says this application needs no new ruling. This entry applies the written rule to all three operations. It adds no mechanism, parser, dependency, schema or decision.

## The test

`packages/github/test/rounds.test.ts` keeps its full response assertion. Three module-level literals hold the expected query text, typed from GitHub's schema and never imported from `src/rounds.ts`. The cursor assertion and the substring loop gave way to one `toEqual` over the whole request body of all eight requests, in order. Each carries its complete variable object: `owner`, `name`, `number`, the cursor and, for associations, the OID of its own head (`head` for the first two pages, `old` for the last two). Replies stay uniform, so the OID is checked per request, not by membership of a set. Whitespace is part of the compared text only because the shipped text already matches; the target is the semantics.

## Why there is no failing ordinary test

This is a test defect. Production is correct, so no unchanged-head runtime scenario fails. The usual failing-test-first rule has nothing to reproduce. The pair below stands in for it: the old tests pass the correct production and the reported cursor deletion, and the new test passes the correct production and fails the deletion. Production was never committed in a mutated form.

## The proof

Each run applied one literal replacement to `packages/github/src/rounds.ts` in place, ran `rounds.test.ts` and `rounds-case.test.ts` with Vitest 5.0.3 on Node 24.18.0 (JSON reporter, four workers), then restored the original bytes. Every restore matched the pre-run SHA-256. A run counts as killed only when both files ran, the full count of 40 tests executed, and every failing test failed by assertion. The 16 Qxx variants are the native review's list. S17 to S19 are mine and are supplemental, not generated inventory IDs.

Before, with the unchanged tracked tests: baseline 40 of 40 passed. **12 variants survived**: Q01 (the reported cursor deletion), Q02, Q03, Q04, Q05, Q06, Q07, Q08, Q09, Q13, Q15 and Q16. Four were already killed: Q10, Q11, Q12 and Q14, all by the paginated test. This matches the native review's counts.

After: baseline 40 of 40 passed. **All 16 Qxx variants were killed**, each with one failure in `pages all connections by hasNextPage, ignoring filtered totalCount`. The four already-killed controls stayed killed.

Supplemental:

- S17, every association request uses `answer!.head` instead of the loop head: the old tests killed it only through `requests historical force-push heads even when commits and current head do not name them`. The old paginated test passed it, hidden by the one-of OID check and uniform replies. Now both tests fail.
- S18, the association query swaps `owner` and `name` bindings: killed before and after, by the paginated test.
- S19, the `name` variable carries the owner: killed before and after, by the paginated test.

The per-variant table is in `tmp/pr256-request-contract-fix/before-after-summary.md`. A strict extra-variable check is a contract assertion. By itself Q15 is not a production failure.

## The inventory

`scripts/enumerate-mutants.mjs 2d63c723cf06d5a492f7c3ec313012ac45926a75...91dc529f56686a092fafe6310a8561540d126c90 --json --limit 10000` ran over a scratch snapshot of the actual test diff. The only changed path is the test. The inventory lists 0 mutants, omits 0 and has 0 unmutated entries. There are no generated claims, so there was nothing to classify or run beyond the supplemental variants, and `--sample` was not used.

## The comparison-read claim, narrowed

[The comparison-read entry](2026-11-04-pr256-comparison-read-scope.md) says unsupported or corrupt data that a command needs still refuses that command. That is broader than what the change did. It preserves refusals for unsupported versions and for the tested corrupt comparisons. It is not schema validation of the trusted membership payload.

The native review found the remaining P3. A `melian.pull-request-rounds` value of `{}` reads as no history, so `melian compare stats` exits 0 and prints `Unattributed pull request rounds: 0.`. A malformed `versions` value prints the stats output and then exits 1 with an untyped `TypeError`. Only someone who forges the trusted store can produce either. Forging trusted stored values is an accepted risk, so this pass adds no shape validation and no policy.

## Limits

- Production is unchanged. Its SHA-256 is `77e9871b61da41e115f8096558e7cd3fd9eeeb23e25b1652c7a37a9bc3afffb9`, the same at the parent, before the runs and after every restore.
- The recorded GraphQL tests in `packages/github/test/threads.test.ts` still use substring checks. They predate this branch and sit outside this pass.
- Aggregate association cost stays as ruled: each connection has its 50-page bound, and no aggregate bound is promised. The offline stored-ownership rule is unchanged.
- The proof runs the expected text against the production text, so it proves they agree. Agreement with GitHub's real schema was inferred, not exercised; no request reached GitHub.
- Fresh final-head reviews and exact-head CI are still to do. This pass started none.

## Whole gate

`npm run check` exited 0 on the host with Node 24.18.0, npm 11.19.0 and `VITEST_MAX_WORKERS=4`, in 454.8 seconds: Biome, pinned-dependency, release-age and tool checks, `tsc`, an `npm audit` at the high level (six moderate advisories, none high), and 221 files with 7,166 passed and 2 skipped. The load average was about 1.8 when it started. The source, test and progress-entry bytes were hashed before and after the run and did not change. The gate ran on the working tree before the commit. This section was added after it, so the committed entry differs from the gated one (SHA-256 `667a1c36668ea0406ada22ad38b2df098c3b81336ffdf2e06e4c25242873ee26`) by this section alone. It is not a run of a committed head.

## What the proof binds

- Parent: `2d63c723cf06d5a492f7c3ec313012ac45926a75`.
- Scratch snapshot: `91dc529f56686a092fafe6310a8561540d126c90`, tree `f8597c8e6dcf67becdc22916f29242d10a5319a5`, test blob `ba83583cb1e97871ddeaa36d7831ccff32c81adb`. It is unreferenced and holds the test only.
- Original test SHA-256: `7f514f6dd64cd6e96312bc4abefc099bcdfdf97d73a4df0f136b45d3c415d236`.
- Final test SHA-256: `e17625087a16ae51446378122bae0d6851116ef1440a97520f8c0136c64e8464`.
- `packages/github/test/rounds-case.test.ts`: `03f7a34e2cb33f241c0c62aaf91f4d8c6dd3c0c296564f2c65e7a656aae95aea`, unchanged.
