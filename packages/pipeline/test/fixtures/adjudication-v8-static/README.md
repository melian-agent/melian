# Main's version 8 adjudication input, with a static check counted

Recorded from production code at `16c0d89cb`, where `melian.adjudication` is version 8 and its input names the creating build's `code`. `capture.test.ts.txt`, copied into that checkout's `packages/pipeline/test/`, ran one `static.tsc` check over a type error and reviewed it, and wrote `recorded.json`: the adjudication task's input and initial checkpoint, read through `Harness.getTask`, and the verdict it decided, `findings`.

A version 8 input names no check run, and its `code` is that build's, so `adjudication-static-reopen.test.ts` proves the current definition fails it rather than decide, and that the next review decides again under its own run.
