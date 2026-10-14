# The mutation check reruns only what changed since the last judged head

Problem: `static.mutation` keys its incremental cache by the exact head commit, so every push starts cold over the whole pull request. A fix that touches one line pays for every mutant on the branch again.

Example: on [pull request #98](https://github.com/melian-agent/melian/pull/98), each new head re-ran about 1,050 mutants in 22 files. Round ten's cold run fitted inside the provisional 7,200-second timeout. Round twelve's took 8,466 seconds and read `not reviewed` for the timeout alone, though every lens and the verifier found nothing above advisory. The branch sat at the limit because each fix pass reset the cache, not because the fixes were large.

Choice: key the cache per pull request, and reuse it across that pull request's heads. The maintainer asked for it: once the mutation gaps of a changeset are found, rerun only the later changes, not the whole pull request.

- The partition is keyed by repository, base-policy commit, installation identity, the run's inputs, and the review's target: the pull request number for `#N`, and the canonical head ref name for a branch range. A range that names a bare commit has no target to share, and runs cold.
- A run reuses the partition only when all of these hold. The partition's last judged head is an ancestor of the new head. The base and the installation identity are unchanged. The earlier run was a trusted case: a writer's head, or a head the reviewer vouched for with `--trust-head`, as its stored `WriterTrust` records.
- Stryker's incremental mode decides which mutants run again: those on lines changed since the last judged head, and those whose covering tests changed. Melian does not compute that set by hand.
- An earlier survivor on an unchanged line stays open as a finding until a change kills it or a maintainer dismisses it with a reason.
- A force-push that drops the last judged head, a base change, or an installation change starts cold, in a new partition.

Why per-head keying was chosen, and why it no longer holds: the first design ran untrusted heads inside a sandbox, beside a cache those heads could influence. A head's test code could change its own staged copy of the incremental file. Keying by exact head kept one head's results from reaching another's run. The maintainer then decided that static checks run unconfined and only for trusted heads ([pull request #98](https://github.com/melian-agent/melian/pull/98)'s unconfined decision). The cache lives in Melian's state directory, which no head's code writes, and a staged copy is published only by a run that still holds authority. A trusted head's cached result is as trustworthy as the run that made it, so reuse across a trusted pull request's heads adds no exposure that running its tests did not already add.

What this gives up: a mutant whose result depends on code Stryker does not see as changed, such as a test helper reached at run time and not by import, can keep a stale `Killed`. The full cold run before the queue is no longer free; the coordinator asks for one with a new partition when a branch's history was rewritten. Reuse also depends on Stryker's incremental mode staying sound, a dependency's behaviour Melian pins and does not re-derive.

It is the first step after [pull request #98](https://github.com/melian-agent/melian/pull/98) lands, and is not added to it.

Supersedes: none. It changes a clause of the mutation decision on [pull request #98](https://github.com/melian-agent/melian/pull/98), which is not yet on `main`; the step that builds it adds a file that supersedes that decision's cache clause and restates the rest.
