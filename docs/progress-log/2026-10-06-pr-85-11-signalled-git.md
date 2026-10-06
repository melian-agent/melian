# Exercise real signalled ignore commands

[Pull request #85](https://github.com/melian-agent/melian/pull/85), sixth fix pass, finding 2bef6e7f3f1dd352.

The signal test fabricated a git result despite the core guideline's ban on mocking git. It now passes spawn through to the real implementation and sends SIGTERM only to git check-ignore. Both source variants assert a real PID, the child's signalCode and a typed unreadable error. Revision setup and ignore-file reads still run real git commands.

Removing both negative-exit guards fails both regressions. Restoring them passes the signal tests and all twenty-four source-reader tests. The core guideline records the pass-through technique and the Vitest spy recursion trap. No production change or design decision is needed.
