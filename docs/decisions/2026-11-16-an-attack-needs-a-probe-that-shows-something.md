# An attack needs a probe that shows something

Amends: [Probe reruns: once a probe, conclusive runs only](2026-11-12-probe-reruns.md), answered attacks

Status: ruled by the maintainer on 2026-11-16, in the coordinator's session, as option C of [issue #493](https://github.com/melian-agent/melian/issues/493). The builder's choices below are marked as the builder's.

Problem: the probe-reruns decision counted an attack as answered once any probe ran for it. A prober whose only probe of an attack timed out, was cut, or was killed left its lens recording `ran`, though nothing was tried. Example: main at `374fdaf7` reviewed a two-attack plan where the only probe of attack 1 died of SIGKILL and attack 2 was skipped. It recorded `ran`, with `skipped: 1` and no attack unanswered. The fixture `packages/pipeline/test/fixtures/probing-v7` holds that store. Telling a kill from a failure was not possible either. bubblewrap reports a child a signal ended as exit 128+n, so a probe that exits 137 itself read the same as one the kernel killed.

Choice:

- An attack is answered by a skip with its reason, or by a probe that shows something: one that exited within its time and output limits with a code other than 125. A probe that timed out, was cut, was ended by a signal, ended with no record of how, or exited 125 shows nothing. An attack whose every probe showed nothing stays unanswered, and the prober is reminded of it once. An attack still unanswered after the reminder ends the lens, as one with no answer did before. A skip after probes that showed nothing counts as skipped.
- A probe exits 125 to say it could not test its attack, as `git bisect` reads it. Its rerun runs again on a repeat review, as a timed-out one does.
- The runner inside the sandbox records how the probe ended: its exit code, or the signal that ended it. It writes the record to file descriptor 3, a pipe of its own. Melian reads at most 256 bytes and takes the last complete line. A record that is absent, malformed or over the bound reads as ended with no record of how, which shows nothing.
- The lens task is version 8. Its outcome's `probing.skipped` lists the skipped attacks by number. A version 7 task stored it as a count, which the record still reads. A finished probing run is never reused, so the review reads no finished version 7 outcome in practice. A live one resumes under version 8 code and recomputes its outcome.
- 124, the exit code `timeout(1)` gives a command past its limit, keeps its meaning as a failure: Melian enforces a probe's time limit itself and records it as `timedOut`, so a probe exiting 124 chose that code. The builder chose this, and the coordinator agreed on 2026-11-16.

What the record fixes, and what it does not:

- It fixes the ambiguity of 128+n. A probe that exits 137 reads as a failure, and one SIGKILL ended reads as ended by it.
- A probe cannot write the record through its own file descriptor 3: that is Node's, not the pipe. `probe-endings.test.ts` asserts the write fails. A probe could still forge it by another route, such as opening its parent's descriptor through `/proc` on Linux. The coordinator accepted that on 2026-11-16, since a probe that forges its ending gains nothing a probe could not get by exiting with that code.

The tests lens may probe. [Pull request #490](https://github.com/melian-agent/melian/pull/490) refused `probe` there, and in any lens that extends it, because an attack its prober answered counted as answered whatever its probe showed, so a test that already failed left the lens clean. That refusal is lifted: an attack now needs a probe that shows something.

Measured: the endings, 0, 137, 125, SIGKILL, SIGABRT, a timeout, a cut, and a write to file descriptor 3, under bubblewrap on Linux in a cloud container on 2026-11-16. macOS runs the same file in CI's macOS job, and on the host: `MELIAN_PROBE_SANDBOX=1 npx vitest run packages/pipeline/test/probe-endings.test.ts`.

What it gives up: a prober that cannot get a conclusive probe for an attack must skip it with a reason, or its lens ends. A flaky probe that timed out under load costs the review that lens.
