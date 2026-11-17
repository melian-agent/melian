# Exit 0 needs the probe's own report

Amends: [An attack needs a probe that shows something](2026-11-16-an-attack-needs-a-probe-that-shows-something.md), how a probe ended

Status: ruled by the maintainer on 2026-11-17, relayed by the coordinator and recorded on [pull request #532](https://github.com/melian-agent/melian/pull/532#issuecomment-6939082709), as option A of the builder's question. The builder's choices below are marked as the builder's.

Problem: the ruling of 2026-11-16 made Node's report of the probe's ending, `{ code, signal }`, the one authority for how a probe ended. Node reports a child that a signal it cannot name killed as exit 0 with no signal. On Linux that covers the real-time signals, 34 to 64. Example: Codex's seventh adversarial review of pull request #532 found that a probe that runs `process.kill(process.pid, 34)` read as exit 0, a passing, conclusive probe, so code under test could pass an attack by ending its own probe.

Choice:

- The probe's own process reports its exit code to the runner from an `exit` handler, over a second pipe that only the runner reads, at file descriptor 4. Node runs that handler when the process exits and never when a signal kills it.
- The runner keeps Node's report when it names a signal or a non-zero code, which Node gets right. It records exit 0 only when the handler also reported 0. Any other exit 0 reads as ended with no record of how, which shows nothing.
- A probe that leaves without its handler, such as through `process.reallyExit`, shows nothing.
- The builder chose these:
  - The handler is set in the watchdog module, which the probe's process imports before the probe's own module, so it is set before the probe runs.
  - When the handler's report has not arrived by the time Node reports the exit, the runner waits for the pipe to end, or one second, whichever comes first. A child the probe left holding the pipe then costs a second, not the probe's time limit.

What it gives up: a probe could write 0 to the pipe itself and then kill itself with a real-time signal, and read as exit 0. That gives it nothing it could not get by exiting 0. As before, a probe could forge the record on file descriptor 3 by another route, such as through `/proc` on Linux.

Measured: signals 34 and 64, a probe that skips its handler, and a child left holding the pipe, under bubblewrap on Linux in a cloud container on 2026-11-17, beside the endings the amended decision lists. Real-time signals are Linux's, so those two cases skip on macOS.
