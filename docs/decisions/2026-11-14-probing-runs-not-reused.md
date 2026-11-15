# A finished probing run is never reused

Amends: [A probing run's attach key holds its whole environment](2026-11-09-probing-attach-key.md), the probing protocol in the instruction fingerprint, the 2026-11-13 rulings that hashed the wording table whole and the sample renderings beside it for the lens task, the known gap for installed dependencies, and the repeat review that plans from its first run's decisions and findings
Amends: [Probe reruns](2026-11-12-probe-reruns.md), the stored rerun that stands for every repeat review, and the repeat review after a reinstall
Amends: [A trust-boundary level that runs probes](2026-11-07-trust-boundary-level-that-probes.md), the stored rerun a repeat review reads
Amends: [Advisory caller context stays outside the lens task's attach key](2026-10-07-caller-context-outside-the-attach-key.md), the repeat review that attaches to the first call's lens task

Status: the maintainer ruled on 2026-11-14, in the coordinator's session, for [pull request #296](https://github.com/melian-agent/melian/pull/296): "can we just let the agent using them if to reuse or not? they are in charge of trying to break functionality", and "can we use our fingerprint as a hint to the agent of whether significant change happend, while telling it it's not exhaustive?", with no mechanical reuse. The coordinator chose, the same day, to delete the probing fingerprint rather than keep it as a key.

Problem: the probing fingerprint decided whether a repeat review reused a finished probing run. It drew a finding in every round for six rounds, each an input it missed: a role tool's contract, how a prompt was put together, what Melian's probe runner gives a probe, the host. On the last, the prompts half of `770e9c2e` and `cfb7604d` named two more. Each fix hashed one more input, and the next round found the next.

Choice: a lens task whose selection holds a probing run attaches only while it is live, which is how a review resumes its own run after a crash. A finished one is never reused: a repeat review creates a new lens task, plans and probes again, and runs every lens of the review again, since one task holds them all. The probing protocol leaves the instruction fingerprint, and with it the role tools, the fixed limits, the wording table and the sample renderings that the 2026-11-13 rulings hashed there. These stay, because they guard trust or one run, not reuse across reviews:

- The selection names a probing run's whole environment, so a review under another writer, policy word, time limit, grant or host never attaches to a live run.
- A probe refuses to open on a host other than the one its run names, so a resumed run never probes on another machine.
- The verifier's version hashes how a claim's probe evidence is worded and rendered, so a release that changes either judges stored claims again.
- The planner's and the prober's prompts take their wording from a table of strings, which a test scans, as the place the prompts live.

A rerun is keyed by its lens run, so a new lens task means new reruns. A stored rerun stands only for a second review that attaches to the same live lens task; it never reaches a later review. The rerun task's rule for that case is unchanged: a conclusive run is kept, and one that was refused, timed out, cut or ended by a signal runs again.

[The fixed-limits decision](2026-11-09-probing-fixed-limits.md) needs no change: its limits bound one run, and each repeat review is a run of its own.

What it gives up: a repeat review of a head whose lenses include a probing level runs every lens again, and pays for it. Three cases:

- A plain repeat review of the same head, such as one the `melian round` workflow starts again.
- A review after a dismissal, where someone reviews again to see the verdict. `melian dismiss` itself re-decides and stores the verdict, and `melian publish` posts it, so neither needs the repeat.
- A crash after the lens task finished, say during adjudication. The resumed review finds the task finished and runs every lens again.

It also gives up noticing a change of build under a live run. A probing task left live by a crash and resumed by another build of Melian continues under the new build's prompts, role tools and sandbox, and nothing detects it. The round on `2ed4426e` named it three times: `3e4a95fe33787019` and `56e0563863365c89`, that the probing host names the sandbox without its version, and `19440a8c1abd94cd`, that the lens task's fingerprint leaves out the probing protocol. No version fence was built. Every Melian package's version stays at `0.0.0`, so a fence needs a build identity of its own, a key of the kind this ruling moved away from. The coordinator has put the three findings to the maintainer as one gap to accept.

No shipped level probes yet, so only a repository or an eval's own lens pays this today. The way out is to run probing lenses in a task of their own, so that a repeat reuses the other lenses and probes again alone. That belongs with the follow-up that gives the agent the fingerprint as a hint, which the maintainer asked for, [issue #427](https://github.com/melian-agent/melian/issues/427); it is not built here.
