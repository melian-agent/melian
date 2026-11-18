# A probe stands in only for what the sandbox cannot hold

Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), what a planner plans and a prober runs
Amends: [Each lens that probes plans, probes and is judged in wording of its own](2026-11-16-probing-wording-per-lens.md), "The trust-boundary lens keeps its words", which now change for this rule, the checkout's place and the cause file

Status: built for [issue #511](https://github.com/melian-agent/melian/issues/511). The maintainer ruled on 2026-11-16, in the coordinator's session, that a probe runs the real code at every hop that can run in the sandbox, stands in only for infrastructure that cannot exist there, such as the runner, the upload service and a real login, and says which hops ran and which were stood in for. The wording is the builder's.

## The problem

The first live probing measurement, on 2026-11-16, showed the prober guessing where its limits lay. The real route of the environment-leak golden runs through a GitHub Actions runner, its artefact upload and Melian's own CLI, none of which a sandbox holds. At low effort the prober fed a made-up verdict to the real comment script and showed the leak. At medium effort the planner forbade a made-up verdict, the prober skipped six of nine attacks, and found nothing. The prober's brief said to skip an attack that needs the network or a credential, so either reading fit it. Two more faults came from the wording. Two of eleven probes failed because they imported the checkout's scripts from the probe's own folder: the brief said the working directory is the checkout, but not that `probe.mjs` sits beside it, in `scratch/probe/`, while the checkout is `scratch/tree/`. And a prober that showed the leak cited the workflow that runs the leaking script, so the script went unscored.

## The choice

- **The stand-in rule.** The planner's shared role says a probe runs the head's own code at every step of an attack's route that can run in its sandbox and stands in only for what cannot exist there, such as a CI runner, an upload service, the network or a real login, and asks it to plan each attack that way and name the stand-ins. The prober's shared answer says the same, asks it to print which steps ran and which were stood in for, and to say so in a finding's failure scenario. It skips an attack only when no probe can show it even with those stand-ins, as when it needs another machine or a race no probe can win. Both lines are shared, so every lens that probes reads them.
- **Where the checkout is.** The first lines of every prober's `probes` say that `probe.mjs` and its files sit in a folder beside the checkout, so a probe reaches a checkout file by a path relative to the working directory, or as `new URL("../tree/<path>", import.meta.url)`, never beside itself.
- **The cause file.** The trust-boundary lens's `findings` asks for the cause in the file whose code lets the input across, not a workflow or configuration that only runs it, which is a context location. The correctness lens's asks for the file whose code is wrong, not one that only calls it. The tests lens's already names the changed line as the cause and the test file as context.
- **The verifier is unchanged.** Its judgement already asks that a probe reach the code the change wrote the way its callers reach it, which a stood-in runner does. No judgement text changes, so `verifierVersion` and every stored verification stay as they were.

## What it costs once

The wording is in each probing run's lens request key and in the trust-boundary golden of the planner's and prober's turns, so both move, on purpose. A finished probing run is never reused, so the key change asks nothing again. A quick run that escalates keys the shared lines, and the planner's role is one of them, so each head reviewed before the upgrade and again after it asks its escalating quick runs once more, as the per-lens wording decision costed.
