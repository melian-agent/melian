# Keep an unavailable saved head as an unreachable member

For [pull request #256](https://github.com/melian-agent/melian/pull/256), `melian compare refresh "#N"` now keeps a saved round whose head is gone from the object store.

## The contract

[The exact-round decision](../decisions/2026-10-18-compare-rounds-exact-rule.md) says a member that becomes unreachable, its commit collected or its storage deleted, stays in the snapshot marked unreachable. It keeps its number and its adjudications. A refresh fails closed only when a rule now rejects an earlier member.

## The defect

A range round whose head GitHub no longer names classifies as `unattributed`. If that round was already a saved member and its commit is also unavailable locally, refresh treated it as a rule rejection. It raised `MembershipError`, kept the old snapshot and asked for `--accept`. The commit was gone, so the member was unreachable and the contract said to keep it.

## The fix

`packages/cli/src/pull-request-comparison.ts` checked head availability only for a saved round classified `member`. It now checks a saved round classified `member` or `unattributed`. An unavailable head takes the existing path: status `unreachable`, reason `head unavailable after fetch`. The change is one operand of one condition.

Three controls keep the rule narrow. Each fails if the condition is widened.

- A readable saved head that GitHub no longer names still needs `--accept`.
- A saved round with explicit foreign ownership is rejected without asking about availability. The test's availability fake throws on any request.
- A new unattributed candidate, one not in the saved snapshot, gets no exemption. It stays unattributed and the saved owned member is untouched.

Foreign and ambiguous classifications keep their existing rules.

## Failing before, passing after

The tests are in `packages/cli/test/pull-request-comparison-unit.test.ts`. They come from the failure scenario and ran first against the unchanged head.

- Before: 20 passed and one failed. The failure was the unavailable-hidden-head test, with `MembershipError: refresh rejects earlier members`. All three controls passed.
- After: the unit file passed 21 of 21.
- Relevant CLI unit and integration suites: 197 passed, none skipped, with two workers. A first run that inherited `MELIAN_STATE_DIR` had one thread-importer failure, which also fails on unchanged production at the parent head. Without that variable the suites pass.

## Manual mutation proof

The enumeration of the fix-only source snapshot lists 14 rows: 12 generated mutants and two ignored string-literal notes in configuration. Nothing is omitted. Every generated row names its test and was applied by hand. All 12 failed their named test with an assertion or `MembershipError`, and none failed through setup, import or timeout. No mutant survived, and none was called equivalent or retried. Two supplemental variants were also killed: removing the `unattributed` exemption fails the primary test, and widening it to foreign fails the foreign control. The runs record the baseline, active, post-run and restored hashes of source and test. The sample was a spot check, not the proof.

## Whole gate, both outcomes

- Sandbox: `npm run check` exited 1 with 7,095 passed, five failed and 53 skipped across 220 files. The failures come from sandbox limits on Git and process-table access: one nested `git init`, three `ps` failures and one supervisor fixture that needs `ps`. The 53 skips are the nested-sandbox wrapper tests, process-table tests and a root-only ownership test. Biome, type checking and dependency checks completed.
- Host: `npm run check` exited 0 with 7,151 passed and two skipped across 220 files, on Node 24.18.0 and npm 11.19.0. The coordinator ran it on the proved production snapshot `9382cc1d3a884611a1503bc9b444db8e3a26244c`, before this entry existed. It is not a run of a committed head.

## What the proof binds

- Parent: `9b6de4a9a185823d8559876ccd3a7880e11d1a70`.
- Production SHA-256: `7e0bd87d1fd684c6d91cf1cd2decb3f2a8e90cb225fe3662f83e0be992413385`. It matches the source snapshot.
- Test SHA-256: `6252d41fa9dac896d57eef359ef0a4fed3ec6b0bc079c25c78597c5365946200`. The test diff is not in the source snapshot. This hash binds it, with the native run receipts.

No design decision or plan status changed. This pass did not touch `docs/design-implementation-plan.md` or `packages/evals/comparisons/`. It makes no claim about a hardened verifier cache or a historical 1037 mutation rerun. Fresh reviews, and the remaining unrelated P2 fixes, are still to do.
