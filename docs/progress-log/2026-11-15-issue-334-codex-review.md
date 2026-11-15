Codex's adversarial review of [pull request #471](https://github.com/melian-agent/melian/pull/471), at `5e8d9384`, raised one medium finding. The new decision said a switch of root shows on the pull request in three places: a reply in the finding's thread, the status description and the ledger. Codex said none of them shows it for a dismissed report merged under a live speaker. Such a report has no thread of its own, the status names no root while a finding is still shown, and the ledger, Codex said, renders neither the report nor its dismissal.

The code agrees on the thread and the status. `Verdict.reviewStatus()` in `packages/core/src/adjudication.ts` names roots only when no finding is shown. It disagrees on the ledger. The test that stands for the finding first asserted Codex's claim: after the switch, no review, no reply, and the status, every comment and the ledger unchanged. It failed on the ledger. The ledger's projection hash changed, and its "Dismissals attested" list and its Dismissals section both named the new root. The test now asserts what the code does, in `packages/pipeline/test/publish.test.ts`, under "publication planning recovery > an inherited dismissal at one head": "names a merged report's new root in the ledger alone while its speaker stays live". It runs the switch and expects:

- no third review;
- no reply;
- the status, still counting one unresolved acknowledgement, and every comment unchanged;
- both ledger lines naming the new root, and none naming the old.

No code changes, so no test can fail before a fix and pass after it. The finding is in the decision's wording, and this test stands in. The coordinator chose to correct the wording, and told the maintainer, who had ruled on a summary that said the status names the new root.

The decision, `docs/design.md` and this entry now state the rule:

- The ledger names the new root.
- The finding's thread names it when the finding has a thread.
- The status names it only when no other finding is shown.

A person's second reason behaves the same way under the dismissal publication decision. The pipeline guideline's sentence and the identity guideline's row claimed no surface, so they stand.

The new test was run against four mutations at `5e8d9384`, each in a probe worktree with its own install, with the source restored after each. A first run linked the main checkout's `node_modules` into the probe, and every mutation passed. That install resolves workspace packages to the main checkout's sources, so the mutations never loaded.

| Mutation | New test |
| --- | --- |
| The fingerprint hashes empty groups and an empty `dismissed` list | killed |
| The fingerprint strips `dismissed` from merged reports | survives |
| The fingerprint keeps a merged report's `dismissal`, its root included | killed |
| The ledger's stamp ignores the projection | killed |

Stripping the merged report's `dismissed` flag survives here, because an inherited report also sits in the verdict's `dismissed` list. Test b in `packages/core/test/restatement.test.ts` pins the flag on its own.
