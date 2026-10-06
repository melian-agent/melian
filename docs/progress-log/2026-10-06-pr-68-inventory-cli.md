# CLI mutation inventory

For [pull request #68](https://github.com/melian-agent/melian/pull/68), round seventeen found that the recorded GraphQL responses did not prove the CLI’s importer arguments. Swapping owner and repository passes the old CLI suite. A new regression asserts owner, repository, pull-request number, author and scripted transport. The swap and four individual argument mutations fail it.

Seventeen direct command tests cover source parsing, missing storage, review-read errors, unsupported GitHub targets, sparse import counts and harness cleanup. They preserve unexpected hand-match errors and add listing advice to comparison errors. Ten surviving mutations fail these tests. The tests use fake models and memory storage. The CLI guideline records why a native-module spy needs resetting before the next golden repository is loaded.

The inventory records 478 distinct proved mutations. Baseline tests already failed 434, including 154 proofs from the earlier comparison sweep. New assertions expose the remaining 44. This pass adds 63 tests. Reports and mutation logs stay under `tmp/`. No design decision changed.
