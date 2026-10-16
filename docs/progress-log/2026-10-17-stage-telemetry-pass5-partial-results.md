# Stage telemetry pass 5: partial check results

[Pull request #135](https://github.com/melian-agent/melian/pull/135).

Pi Durable permits failed and aborted outcomes to carry a partial result. The pass-4 tests omitted those results. Replacing only `task.state.outcome.status === "completed"` with `true` therefore survived.

Two reader cases now supply a partial `ran` check result beside a failed or aborted receipt. Both fail under that mutation: telemetry reports `completed` and loses the failure message. They also fail when the whole line-213 condition becomes `true`. Restoring the source passes all 30 reader tests.

The whole-condition mutation already failed the running-check test in pass 4. Forcing only the terminal-state comparison to `true` also fails that test. The pass-4 report now distinguishes those expressions from the surviving outcome comparison. Exact replacements and red/green logs are in `tmp/stage-telemetry-pass5-inventory.md`.

Together with `16f74826`, this pass kills the two remaining non-equivalent survivors. The four earlier equivalences stay unchanged. Production code, stored shapes and step status stay unchanged.
