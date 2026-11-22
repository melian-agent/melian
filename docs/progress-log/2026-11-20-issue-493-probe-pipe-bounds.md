# Issue #493: the probe runner bounds what it keeps of its exit pipe, and a test holds the record bound

Round [run 44645853916](https://github.com/melian-agent/melian/actions/runs/44645853916) on [pull request #532](https://github.com/melian-agent/melian/pull/532) raised two acknowledge findings on `packages/pipeline/src/probe.ts`. The coordinator asked for both fixes, each starting with a failing test.

- The runner appended everything a probe wrote to fd 4 to one string, so a probe that flooded the pipe grew the runner's memory without limit. It now keeps three characters, enough to tell `0\n` from anything longer. Before the fix, a probe that wrote 640 MiB to fd 4 and exited 3 read as an ending with no record of how, because the runner died past the longest string V8 holds. After it, the probe reads as exit 3. A second test has a probe write `0\nx` and leave by exit 0 without its exit handler. That probe reads as an ending with no record of how, which kills a bound of two characters.
- Nothing tested the 256-byte bound on what a run keeps of fd 3 through `Probe.run`. A fake sandbox now writes a record whose opening newline falls at the 256th byte from the end, and one past it. The first reads as exit 3 and the second as no record. A third test writes a short record after a 4000-byte prefix, which still reads. These tests pass at the head they were written against, since the bound was already there. The mutants below prove them.

## Mutants

The tests ran against their own named test alone, each passing unmutated and collecting one test, with `MELIAN_PROBE_SANDBOX=1`. Every mutant failed its test:

- Stryker's `StringLiteral` on the runner's fd-4 line, under "reads a probe that exits 0 as passing". The empty probe then fails `Probe.availability`, so the suite's name gains its reason, and the run's pattern matches the suite with or without it.
- Stryker's `BlockStatement` on the `record` callback, `ArrayDeclaration` on `[record, chunk]`, and `UnaryOperator` on `-recordLimit`, under "reads a record at the 256 bytes a run keeps of fd 3".
- Dropping `.slice(0, 3)`, under the flood test, and `.slice(0, 2)`, under the `0\nx` test.
- Dropping `.subarray(-recordLimit)`, and a bound of 257, under the test one past the bound. A bound of 255, under the test at the bound.
