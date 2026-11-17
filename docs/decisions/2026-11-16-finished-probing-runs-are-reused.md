# A finished probing run is reused when its request is unchanged

Amends: [A finished probing run is never reused](2026-11-14-probing-runs-not-reused.md), "A finished one is never reused: a repeat review creates a new lens task, plans and probes again", "A stored rerun stands only for a second review that attaches to the same live lens task; it never reaches a later review", and what it gives up
Amends: [A lens run is reused by its request key, one lens at a time](2026-11-15-lens-runs-reused-per-request.md), "it does not probe;", "A probing run is never copied, so every finding it reports rests on a probe of its own review", "or a probing lens, whose finished run is never reused", and "Probing repeat: a repeat review of a selection with a finished probing run runs the probing lens again, and pays for it alone"
Amends: [A repeat review of a probing run attaches only while the run is live](2026-11-15-repeat-review-of-a-probing-run.md), each sentence it rewrites "for a selection that holds a probing run"
Amends: [A probing run's attach key holds its whole environment, and no moving context](2026-11-09-probing-attach-key.md), "The host is one value: the sandbox's platform and kind, and the CPU architecture and version of the Node that runs the probes"

Status: the maintainer ruled on 2026-11-16, in the coordinator's session, as [issue #514](https://github.com/melian-agent/melian/issues/514) records: "Whether probing or not, a lens with the same running parameters (including the fact that it is a probing lens) on the same code, should not be run again." He asked for the change to be fast-tracked, said he accepts the risk, and said the installed dependencies of the code under test need not be in the key. The issue asked for this file to supersede [the 2026-11-14 decision](2026-11-14-probing-runs-not-reused.md). The builder amends it instead: two active decisions amend it, and the decision index refuses an amendment of a superseded decision, so superseding it would mean superseding both of them and the decision that amends one of those.

## Problem

A repeat review of an unchanged head copied every finished lens run whose request key matched, except a probing run. `lensCopies` refused any run with a probe, and the lens task attached to a finished task only when no run probed. So the probing lens planned and probed again on every repeat.

That costs each repeat a probing run, $0.65 to $1.69 and about four minutes on the first four host rounds. Probing is not deterministic, so a repeat can also report a finding its first run did not. Example: a finisher records a dismissal and repeats the round to publish the verdict. The probing lens runs again and may block a pull request that had just read clean.

The 2026-11-14 ruling answered a hand-built probing fingerprint that missed an input in six rounds running. [Pull request #466](https://github.com/melian-agent/melian/pull/466) has since replaced fingerprints with a key taken from the request itself.

## Choice

A finished probing run is reused by the rules every lens run follows. A repeat review whose every request matches attaches to the finished lens task. One whose requests differ copies each run that stands, and, for a quick run, only with the run it escalated to standing too. Before it attaches to a finished task, a repeat review asks the same rule: under `--rerun` of every run, and otherwise of every run that probes. A task holding a run that does not stand is replaced, and the new task copies the runs that do.

### When a finished run stands

One function, `runStands` in `packages/pipeline/src/review.ts`, decides whether a finished run may stand for its lens in a later review. The copy asks it of every run, and the attach, in its read ahead and its commit, asks it of every run under `--rerun` and of every probing run otherwise. A plain repeat still attaches to a task whose lens that does not probe failed, and shows what it stored, as it always has: `--rerun` is how such a lens runs again. A probing run is new to reuse, so a plain repeat reuses one only when it stands. A run stands when both halves hold:

1. **Its record reads ran.** `runStands` asks `lensRecord`, the function that writes the lens's record, so a run whose record reads ended or failed is never reused, for any reason the record knows now or learns later: an outcome other than done, an attack the prober left unanswered, a findings cap, lost standards, or a budget's end at a level that does not count it. The record then goes through `plan.mark`, which fails a run that finished on a model the plan refuses, so `runStands` also asks the same `refused` question of every model the run was judged by: the one it finished on and, when its prober runs on the level's own tier, the prober's.
2. **Every probe it tried ended conclusively.** `probesConclusive` in `packages/pipeline/src/probing.ts` reads the prober's `ProbingDocument`: each `run_probe` call's ID in `attempts` must have a stored result, and that result must be conclusive by `probeConclusive`, the definition the rerun task uses. A probe the sandbox refused leaves an attempt with no result; one that timed out, was cut or was ended by a signal says nothing. A run holding one is not reused, and the next review of that head plans and probes again.

Three reviews found the three cases this rule closes, each a place where reuse asked a narrower question than the record. Codex's adversarial review at `b4dd5bef` found a prober that failed over to a fallback the committed tier refuses: the record failed the lens, but the copy and `--rerun` read only the planner's model. The Actions round at `b4dd5bef` found a run whose prober left an attack unanswered: the record read ended, but reuse read only the top-level `done`. The review of record at `b4dd5bef` found a run whose every probe the sandbox refused: the prober reported nothing, so the record read ran and clean, and every later review of that head copied it and never probed again. In each, the review stayed wrong until its request changed.

A prober on a tier of its own is not judged by model, since its check's lineage does not yet hold it, as [the prober-tier limit](2026-11-14-prober-tier-lineage-limit.md) says; judging it by the level's policy would refuse a model its own tier accepts. A probing outcome names no other model: a failover leaves only the model each conversation finished on, and a run a quick one escalates to is an outcome of its own.

What the second half costs: a head whose probes keep timing out, on a loaded machine say, or that the sandbox keeps refusing, is planned and probed again on every review until its probes end conclusively. Each such review pays for the probing run again, $0.65 to $1.69 and about four minutes on the first four host rounds.

A copied run keeps its probe evidence and the verifier's reruns. A rerun is keyed by the revision and `rerunKey`: the claim's check and version, and the probe's ID, which is the prober's tool task. A copied outcome names the planner's and prober's conversations of the task that asked it, so `claimProbes` reads the same probe, under the same ID, and the rerun task finds the run it stored. A stored run that failed or passed runs no more. One that was refused, timed out, was cut or was ended by a signal runs again, as before. A review that attaches to the finished task attaches to its stored verification too, while the verification's input and the stored reruns are unchanged.

The lens run's request already holds what a probing run is asked, as `lensRequest` builds it: the run under the fixed nonce with its route, level, thinking, budgets and instructions, and its probe, the prober's route, thinking, instructions and whole probing environment. It also holds the planner's and the prober's tools with their limits, the probing wording they read, the shared lines and its lens's own entries as [the per-lens wording decision](2026-11-16-probing-wording-per-lens.md) sets them, the base and head, the installed Pi versions, the injection policy and the standards. The environment names the writer, the policy's `trust.writers`, the probe time limit, the policy's `probe.read` and the host.

The host gains one field, `sandboxVersion`, the installed release of sandbox-runtime, which `probingHost` reads from the package's own `package.json`, as the Pi versions are read. A release of the sandbox can change what a probe may do, so a review after an upgrade runs each probing lens again. A test's own sandbox reports the installed release too.

These clauses of the 2026-11-14 decision stand:

- The selection names a probing run's whole environment, so a review under another writer, policy word, time limit, grant or host never attaches to a live run, and now never copies a finished one.
- A probe refuses to open on a host other than the one its run names, so a resumed run never probes on another machine.
- The verifier's version hashes how a claim's probe evidence is worded and rendered, so a release that changes either judges stored claims again, as [the per-lens wording decision](2026-11-16-probing-wording-per-lens.md) now words it.
- The planner's and the prober's prompts take their wording from tables of strings, the shared one and each lens's own, which tests scan, as the place the prompts live.
- [The fixed-limits decision](2026-11-09-probing-fixed-limits.md) needs no change: its limits bound one run, and a reused run ran within them.

The clauses the 2026-11-14 decision amended in other decisions read again as their own files say, for a reused probing run: a repeat review plans from the decisions and findings its first run read, a stored rerun stands for every review that reuses its run, and a repeat review after a reinstall reuses the probing runs and conclusive reruns of the first. A new probing run never finds another run's reruns, since its probes have IDs of their own.

The sentences [the repeat-review decision](2026-11-15-repeat-review-of-a-probing-run.md) rewrote for a selection that holds a probing run now read as they do for any selection: a repeat call attaches to a finished task, a repeat review with an empty delta spends nothing, and the first call's functions, caveat, verification and telemetry stand.

This closes [issue #427](https://github.com/melian-agent/melian/issues/427), the planner's hint, which stood in for a key that could be trusted.

## Left out of the key

- Melian's own probe runner and the lens tools' code: what `Probe` and `runHeadProbe` give a probe, such as its environment, paths and the tree they write, and the text `run_probe` returns. Until [issue #437](https://github.com/melian-agent/melian/issues/437) ties a code version to a hash of that code in a test, a Melian release that changes them, with every keyed version unchanged, attaches to or copies a run probed under the old code. Its findings, or its clean result, stand on what the old runner showed, and no probe runs under the new one until the head or another keyed input changes.
- The installed dependencies of the code under test, by the ruling. The environment names `node_modules`, not what it holds. A reinstall between two reviews of one head copies the run and its conclusive reruns, so a finding can stand on a dependency that is gone, and a defect a new dependency brings goes unprobed until the head changes.
- What the files under the base policy's `probe.read` paths hold. The environment names the paths, not their contents. Example: the policy grants `generated/schema.json`, which is untracked. A review of one base and head runs while the file holds schema version 1, and its probe passes, so the probing lens finishes clean. A build then regenerates the file at version 2, under which the same probe would show the defect. The next review of that head has the same request, so it attaches to the finished run, or copies it beside a changed lens. No probe reads version 2, and the clean result stands until the head, the policy or another keyed input changes.
- Whether the filesystem folds case. The probe's tree is written under the system's temporary directory, and a review reuses a probing run only from its own store, which lives in its own checkout. A host whose temporary directory moves to a volume that folds differently copies a run probed under the other rule.
- The operating system's release, the CPU's model, and the host's locale and clock, as [the identity guideline](../guidelines/identity.md) already says: the platform and architecture name what a probe runs on, and no probe should hang on the others.
- A live probing task left by a crash and resumed by another build of Melian, which continues under that build's prompts, role tools and sandbox. The selection matches, so nothing detects it, as before. The new host field catches a resume under another sandbox release: its probes refuse to open.

## What it costs

The first review of each head after this lands runs each probing lens once more, since every probing run's host now names the sandbox release. Lenses that do not probe hold no host and are unaffected.

A finding that a probing run reported is not probed again on a repeat review. Where the head has not changed, that is the point of the ruling; where the dependencies or the runner have, the list above says what can go wrong.
