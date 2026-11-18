# Main's version 7 adjudication input, with a static check counted

Recorded from production code at `e421b5541`, where `melian.adjudication` is version 7. `capture.test.ts.txt`, copied into that checkout's `packages/pipeline/test/`, ran one `static.tsc` check over a type error and reviewed it, and wrote `recorded.json`: the adjudication task's input and initial checkpoint, read through `Harness.getTask`, and the verdict it decided, `findings`.

A version 7 input names no check run, so `adjudication-v7-reopen.test.ts` proves its counted static check reads as replaced once the current definition resumes it.
