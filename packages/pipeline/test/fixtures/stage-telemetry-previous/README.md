# Tasks before stage timing

`tasks.json` records running tasks written by the definitions at `24958d30`, with Pi 1.1.0 installed. The capture ran the phase 1 full review and fake publication test, recording task writes from storage commits. It includes check version 2, decision version 1, adjudication version 1 and publication version 2. No fixture field was built by hand.

The reopen test uses these inputs and checkpoints through definition tokens of their recorded versions. Repository paths are remapped to the test repository. The old checkpoint has no timing marker; its migration must mark it legacy rather than invent a start.
