# Issue #481: a store write that lands and then fails

For [issue #481](https://github.com/melian-agent/melian/issues/481), on [pull request #575](https://github.com/melian-agent/melian/pull/575).

Codex's review at `a6224c89a` found that `melian dismiss --records` can leave a record in the store while the host records nothing. One way was already in the written-once decision: the host's commit fails after the write. The other was new. The store port allows an `add` that lands its records, in whole or in part, and then reports failure. `dismiss` then refuses with `storeFailed`, and the store keeps the record. The decision said that case left no record in the store.

A test, "records nothing in the store when the store's add lands the batch and then fails", failed on `a6224c89a` with the record still listed. The coordinator chose on 2026-11-20 to keep the maintainer's ruled order and correct the decision. The test now pins what happens: the store keeps the record, the host records nothing, `dismiss` refuses, and running it again dismisses on the host and writes the same record. The refusal for a failed write now says the store may hold the record and to run the command again. A failed listing, which writes nothing, does not say so.

`2026-11-20-issue-481-store-landed-mutant-runs.json` holds seven hand mutants of the new clause. Each ran alone against its named test, which passed unmutated, and each failed mutated.
