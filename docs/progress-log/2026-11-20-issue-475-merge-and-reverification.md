# Issue 475: the merge of #481's branch, and a test that an import re-verifies

[Issue #475](https://github.com/melian-agent/melian/issues/475) imports another host's records so a review can resume from them. This entry covers merging [issue #481](https://github.com/melian-agent/melian/issues/481)'s branch, [pull request #575](https://github.com/melian-agent/melian/pull/575), into it.

## What the merge broke, and the fixes

Four tests failed after the merge.

- The code hashes in `packages/pipeline/src/code-hashes.ts` were stale. `npm run code-hashes` wrote them again.
- `packages/pipeline/test/fixtures/lens-task-v7` held a store captured at the old merge base. It was captured again at `1dc69f73`, the new merge base, by its own `capture.mjs` in a throwaway worktree, and its README names that commit.
- Two CLI tests planted records that the merged schemas refuse. A check record's notes now take `maxItems: 0`, so the resume test plants a version, `99.0.0`, on the guardrails record instead. The planted lens record's key is now 64 hex digits. The resume test still fails when `ImportedRecords.check` answers nothing.

## The re-verification test

A verification's key names each dismissal record its verifier was shown, since #481. A host that imports another host's verification must therefore ask its own verifier when its own dismissal of the root is a different record.

`packages/pipeline/test/restatement.test.ts`, "asks its own verifier when it imports a verification made against another host's dismissal of the root", covers this. Two hosts each review the first head and dismiss the root, and only the first shares its dismissal. After a push, the first host reviews the restatement and exports its records. The second host then reviews with those records imported. It asks its verifier, and its verdict needs no attention.

The test fails when the key leaves out the record IDs. To check, `candidateIdentity` in `packages/pipeline/src/verification.ts` was changed by hand to strip `record` from each shown dismissal. The test then failed with `expected 0 to be greater than 0`, and passed again once the source was restored.

The change adds a test and touches no source, so no file in it guards trust or durability.
