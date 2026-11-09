# A trust-boundary level that runs probes

Status: ruled by the maintainer, 2026-11-07, in [issue #288](https://github.com/melian-agent/melian/issues/288). Built by its first pull request; its goldens follow in the next, and its live measurement in [issue #356](https://github.com/melian-agent/melian/issues/356).

## Problem

A lens reads and searches; it never tries the boundary. On trust surfaces the reviews of record found what Melian's rounds missed by running probes, so the coordinator ran both, and paid twice.

Example: on [pull request #275](https://github.com/melian-agent/melian/pull/275), a head `biome.json` that extended `/proc/<pid>/environ` would have put the runner's logins in a public comment. Only running Biome on such a file showed it. `melian compare stats` counts nine `needs-execution` misses, every one found by running something. [Issue #285](https://github.com/melian-agent/melian/issues/285) built `Probe`, which runs a model's script under sandbox-runtime, as [the sandbox decision](2026-11-07-probes-run-under-sandbox-runtime.md) records. Nothing let a lens use it.

## Decision

A lens level may probe. `probe` on a level names the prober's tier, the level's own when absent, and each probe's time limit, the pipeline's 30 seconds when absent. No built-in level probes yet. The maintainer ruled on 2026-11-07 that the built-in `trust-boundary` lens's `deep` level turns probing on once the live measurement picks the planner and prober routes, so no route is committed before the measurement. Until then the goldens and the live measurement declare the level that probes in their own lenses. A level that probes runs as two conversations, each on its own route.

1. **The planner** runs on the level's tier, with the lens's instructions, the change, the decisions at base and the findings of the change's last earlier revision. It writes a numbered attack plan with one `record_plan` call and nothing else: no probe, and no finding but an injection attempt. Each attack names its target, why something untrusted might cross a boundary there, and what a passing and a failing probe would print. The plan is an artefact of its own, the planner conversation's `ProbingDocument`. A planner that finishes without one is reminded once, and the lens fails if it still records none. An empty plan runs no prober.
2. **The prober** runs on its own tier and receives the plan alone: no diff, no lens body, the lens's rules and reporting policy, and the read tools. It answers every attack with at least one probe through `run_probe`, or records it skipped with `skip_attack` and the reason. A prober that leaves an attack with neither is reminded once; one it still leaves ends the lens, and the review is not reviewed.
3. **`run_probe`** writes the head's tree into scratch from git's blobs, without the head's attributes or filters, links the checkout's install at `node_modules`, and runs the probe there through `Probe`. The record, keyed by the call's tool task, holds the script, its files, the result and the time, so a replay returns it. A probe counts against the tools budget as a read does.
4. **A finding** from the prober names the probe it rests on, and `report_finding` refuses one whose probe did not fail: a non-zero exit, not a timeout, a signal or cut output.
5. **The verifier** receives the plan, the probe's script, files and result, and the result of running it again, which the review does before the verifier starts and stores on the root, so a repeat review reads the stored run. It judges by the result and by whether the probe exercises the claim. `report_verdict` refuses `confirmed` for a claim whose probe did not fail again.

There is no fixed probe count. The bound is the level's token and tool budgets and the per-probe time limit. Each of the run's two conversations takes the level's token and tool budgets whole, so a level that probes may spend twice what one conversation may; the findings budget is shared. Each conversation's stage telemetry names its role, and the prober's names its probe count, their time and the limit. The lens's check record says how many attacks the plan held, how many probes ran in what time, and how many attacks were skipped.

A level that probes runs its probes only where a probe may: the host has said the head is a writer's or the reviewer's, the base policy trusts writers, and an empty probe runs here. Its prober's tier must also route, and the plan must not refuse it. Elsewhere the level runs as it would without `probe`, one conversation reading as the lens reads, and the lens's record says why. Triage's question is unchanged, so a fork's head still gets the closest look its band allows, and the probes are lost only there.

## Rulings it reads, and pull request comments

The planner reads rulings from the base's decision files, through the same index the `design` lens reads, and the findings of the change's last earlier revision, dismissals among them with their status. The maintainer ruled on 2026-11-07 that it reads no pull request comments. A ruling that lives only in a comment does not reach it. If the measurement shows a miss a comment would have caught, the fallback to adopt is bounded: only comments whose author has write, maintain or admin permission, checked as the agent rules check them; at most 20 comments and 8 KiB; inside the review's boundary as data, never as instructions.

## What it gives up

- The plan judges the level's own tier. A prober on another tier is refused when the plan refuses that tier, but a fallback model the prober finishes on is not judged against the tier's `accept`.
- Review coverage records what the planner read, not the prober's reads.
- Each probe writes the head's tree afresh: about half a second for Melian's own 21 MB. A lens's probes run one at a time, so the scratch holds one tree for each lens whose level probes. Lenses run at once, so two such lenses hold two; no shipped level probes yet, and [issue #349](https://github.com/melian-agent/melian/issues/349) queues every probe in a process before a second one does.
- A probing run's verifier is chosen against the model the run's prober finished on, or its route when the run failed first. A sighting names its lens, not whether the planner or the prober reported it, so an injection attempt the planner reports is judged against the prober's family too. The maintainer accepted that on 2026-11-08, in the builder's session, over recording the reporter on each sighting, which would change the findings document's stored shape.
- A probe reads the checkout's third-party packages through `node_modules`; a workspace package linked there points outside the probe's reads, so a probe imports the head's own packages by path.
- The planner is reminded once, and so is the prober. A model that ignores both leaves the lens failed or ended. A reminder does not check first whether a later review replaced the run, so a replaced run can ask one more question.
- A quick run that escalates to a level that probes carries its findings to the planner alone, which may report none, so the probing run neither restates nor refutes them and they count as the quick run reported them. No built-in lens escalates into a level that probes: `trust-boundary`'s `quick` escalates to `careful`.

Measuring which routes to commit, the goldens from this week's probes and the `needs-execution` misses, is the issue's second part.
