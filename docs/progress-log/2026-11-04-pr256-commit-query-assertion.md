# Assert the commit OID selection in the round-membership test

For [pull request #256](https://github.com/melian-agent/melian/pull/256), the `MelianRoundCommits` request test now asserts that the query selects `nodes { commit { oid } }`.

## The gap

`packages/github/test/rounds.test.ts` checked the commit query's connection and `pageInfo` but not the nested OID selection. The recorded fake answers by operation and cursor, so it returned OIDs even when the query asked for `id`. [The GitHub guideline](../guidelines/github.md#tests) already says to assert every field the reader uses, nested fields included.

## Why there is no failing ordinary test

This is a test defect. Production asks for `oid` and is correct, so no runtime scenario fails at head `5318223df9456f87ca529919fdd37ad4836328a8`. The usual failing-test-first rule has nothing to reproduce. The survivor-before and kill-after pair below stands in for it. I did not change the correct query or relabel a mutated source as head.

## The proof

All runs used Vitest's JSON reporter with two workers, on `packages/github/test/rounds.test.ts`. The variant is one supplemental literal, `nodes { commit { oid } }` to `nodes { commit { id } }` in `packages/github/src/rounds.ts`. It is not a generated inventory ID.

- Baseline, original bytes: 39 of 39 passed.
- Survivor before: the variant with the unchanged test also passed 39 of 39. The test could not see the change.
- Baseline with the new assertion: 39 of 39 passed.
- Killed after: the variant with the new assertion passed 38 and failed 1. The failure was `pages all connections by hasNextPage, ignoring filtered totalCount`, at `rounds.test.ts:121`: `expected 'query MelianRoundCommits(...' to contain 'nodes { commit { oid } }'`. It was an assertion, not a setup, import or timeout failure.
- Restored: production was restored byte for byte and the final bytes passed 39 of 39.

## The inventory

`scripts/enumerate-mutants.mjs 5318223df9456f87ca529919fdd37ad4836328a8...<snapshot> --json --limit 10000` ran over a snapshot of the actual test diff, `0b146aebdccd465e52a59e1af1f03dc22b7f76a3`. The only changed file is the test. The inventory lists 0 production mutants and omits 0. There are no new generated claims, and `--sample` was not used.

## Whole gate

`npm run check` exited 0 on the host with Node 24.18.0 and npm 11.19.0, and `VITEST_MAX_WORKERS=4`: 221 files, 7,166 passed and 2 skipped. It ran on the working tree with this change before this entry existed. It is not a run of a committed head.

## What the proof binds

- Parent: `5318223df9456f87ca529919fdd37ad4836328a8`.
- Production SHA-256: `77e9871b61da41e115f8096558e7cd3fd9eeeb23e25b1652c7a37a9bc3afffb9`, unchanged from the parent.
- Original test SHA-256: `4b97a17478a52156e2cbbba2b4deab5079faa7499884bd83bb8f53d96eafdc6e`.
- Final test SHA-256: `7f514f6dd64cd6e96312bc4abefc099bcdfdf97d73a4df0f136b45d3c415d236`.
- Variant production SHA-256, temporary: `559efd5ee145c5579fb0d0fdfe46923de52c7081dd99c0589e60575a620ab163`.

No design decision or plan status changed, and the null-after support is untouched. This makes no claim about a hardened verifier cache or a historical mutation rerun. Fresh reviews and exact-head CI are still to do.
