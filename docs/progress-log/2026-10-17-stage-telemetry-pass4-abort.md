# Keep an interrupted stage's original start

[Pull request #135](https://github.com/melian-agent/melian/pull/135), pass 4, finding `3528d10d5840dd92`.

A new in-process task test starts at 100, parks after its start memo is committed, and aborts at 500. It checks the detached reader's original start, terminal end and 400 ms duration after Pi has cleared task memos.

Replacing `TaskTiming.read`'s memo lookup with `undefined` fails the duration assertion. Restoring it passes both timing tests. No production change was needed.
