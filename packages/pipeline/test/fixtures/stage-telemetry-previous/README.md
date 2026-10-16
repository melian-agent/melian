# Tasks before stage timing

`tasks.json` records running tasks written by the definitions at `24958d30`, with Pi 1.1.0 installed. The capture ran the phase 1 full review and fake publication test, recording task writes from storage commits. It includes check version 2, decision version 1, adjudication version 1 and publication version 2. No fixture field was built by hand.

The reopen test uses these inputs and checkpoints through definition tokens of their recorded versions. Repository paths are remapped to the test repository. The old checkpoint has no timing marker; its migration must mark it legacy rather than invent a start.

## Adjudication before and after hunk merging

`adjudication-v1.json` records main at `ddf7c1136660eddac41bcad03dc0af64ede15c2d`, before [pull request #131](https://github.com/melian-agent/melian/pull/131). `adjudication-v2.json` records main at `ba8be99e`, after that pull request. Both captures used Pi Durable 1.1.0 and fake models.

Each capture ran that commit’s own `reviewChangeset` and task definition from an extracted source tree. A storage `commit` wrapper copied the running `melian.adjudication` task write before forwarding it. After review, `harness.snapshot(FindingsDocument, root.id)` supplied the findings beside it. No stored field was assembled by hand.

The capture test used the dismissal test’s two-lens repository and review helpers. Correctness reported the P1 dereference on line 8. Contracts reported `changed-return` at P2 on lines 7–8. Their snippets differ, their lines overlap and one hunk caused both. Version 1 stored no `files`; version 2 stored the hunk ranges. The reopen test restores the recorded findings and task through a token of its recorded version, closes SQLite, then runs today’s definition. It checks the verdict, the complete preserved input and unavailable timing.
