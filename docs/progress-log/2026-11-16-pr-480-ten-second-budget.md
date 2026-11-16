On [issue #480](https://github.com/melian-agent/melian/issues/480)'s branch, [pull request #498](https://github.com/melian-agent/melian/pull/498), a stop of core's `git` now has ten seconds, not three. A call settles within about fifteen seconds of its deadline or output bound.

The number was measured. CI's macOS job ran "reads the process table while git runs, and signals git and its transport by pid", a real stop of git and its transport, in these times before the budget existed:

| Head | Time |
| --- | --- |
| `3a375395` | 3,823 ms |
| `9c1a5019` | 3,041 ms |
| `c9aa445b` | 2,484 ms |
| `96d10748` | 2,682 ms |

Each time includes the test's 500 ms deadline. On `eff71604`, a head that changed only documentation, the same job took 3,685 ms and got `childrenLeft: true`: the three-second budget gave up part way through SIGTERM, and the runner cleaned up two orphaned `sleep` processes afterwards. Each read of macOS's table is slow, and a stop reads it about 2N+3 times for N processes, before every signal and while it waits. The coordinator chose ten seconds on 2026-11-16, as a choice of approach, which leaves about three times the slowest stop measured. Nothing in `process-tree.ts` changed.

- The tests came first. On `67903a21`, "reads the table at the end of the stop's ten-second budget" got `childrenLeft: true`, since a clock at 10,000 ms was past the old budget. "gives up on the real clock once the stop's reads have taken ten seconds" got no signal at all, since the old budget ran out after the second read. With `30fa9bc3` both pass, as does "reads and signals nothing more one millisecond past the stop's budget, and says the children may still run" at 10,001 ms.
- Stryker's instrumenter makes no mutant of the changed line, the budget's number, so the commit owes no claim; the bound tests at 10,000 and 10,001 ms hold it.
