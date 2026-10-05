# The ledger

[Pull request #73](https://github.com/melian-agent/melian/pull/73) adds one signed ledger comment per pull request. Melian edits it in place across heads.

The ledger holds the verdict, an optional walkthrough, run details, dismissal reasons and collapsed earlier rounds. A signed stamp makes each edit idempotent after a crash or a lost local record. The commit status links to the ledger.

An addressed finding now gets an edit naming the first commit that addressed it, and its thread resolves. Dismissals keep their reply. `melian findings` prints a fenced agent prompt; `--json` is unchanged. `publish.walkthrough` and `--no-walkthrough` switch the summary off.

The stored `melian.published` and `melian.verdicts` shapes move from version 3 to 4. Older records stay readable and gain no invented history. `melian.ledger`, `melian.summaries` and `melian.walkthrough-result` are new at version 1.

The brief's 5 October dismissal decision was absent, so the work follows [the 4 October decision](../decisions/2026-10-04-dismissal-publication.md). [The ledger decision](../decisions/2026-10-05-ledger-publication-projection.md) records the projection.

[Pull request #61](https://github.com/melian-agent/melian/pull/61) has not landed. After it does, merge `main` and check that its route-departure section reaches the ledger. Timings stay deferred: the old run record stores none.
