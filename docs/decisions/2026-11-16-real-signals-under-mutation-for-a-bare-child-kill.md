# Real signals under mutation only for a bare `child.kill()`

Status: the maintainer chose this on 2026-11-16, in the coordinator's session, answering "A". The coordinator had recommended the other option: keep the rule as written and prove every signalling file on a fake `kill`.

Choice: a file that sends signals is mutated with real signals only when all of these hold.

- Its only signalling is `ChildProcess.kill()` with no argument.
- It contains no `process.kill` and no signal name, which `grep -nE 'process\.kill|SIG[A-Z]+' <file>` confirms.
- The processes it signals are children the test itself spawned.
- The runs happen in a cloud container, never on a maintainer's machine.
- Only mutants with no pid or signal operand run: one that deletes the call, empties its block, or changes when it runs.
- The scratch runner stops a hung test by the pids it recorded, SIGTERM then SIGKILL, and signals nothing else.

Every other file that sends signals keeps the rule in `AGENTS.md`: never run a mutation over it, and prove its guards on a fake `kill`.

Why: the rule came from code that computed a pid and sent `kill(-1)`, which reached every process the user owned. A bare `child.kill()` holds no pid or signal for a mutant to change. Node takes the pid from the child `spawn` recorded, and the signal is SIGTERM. A mutant of such a file can only stop the right child sooner, later or not at all. A fake `kill` would prove the same guards but not that the real child ends, which `packages/core/src/git.ts`'s tests check. [Pull request #472](https://github.com/melian-agent/melian/pull/472) ran its 48 mutants of that file this way, in a cloud container. [Issue #480](https://github.com/melian-agent/melian/issues/480)'s code records pids and signals each one, so it does not qualify, and its guard is proved on a fake `kill`.
