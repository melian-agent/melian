# A repeat review of a probing run attaches only while the run is live

Amends: [Review attachment](2026-10-03-review-attachment.md), "a repeat call attaches, never duplicates", for a lens task whose selection holds a probing run
Amends: [A coverage ledger decides what a round reviews](2026-10-23-coverage-ledger-and-delta-review.md), item 8, a repeat review that spends nothing
Amends: [Restore the enclosing functions clauses](2026-11-08-restore-enclosing-functions-clauses.md), "A repeat call attaches to the first call's lens task", for a selection that holds a probing run
Amends: [Triage clears a superseded verdict](2026-10-06-triage-clears-superseded-verdict.md), "Finished lens tasks stay attachable", for a selection that holds a probing run
Amends: [Quiet review body](2026-10-25-lens-notes-leave-the-review-body.md), item 4, a repeat review that keeps the first call's caveat
Amends: [Verify each lens's claims as that lens ends](2026-11-07-verify-as-each-lens-ends.md), "A repeat review attaches to the task it ran before", for a review whose lens task holds a probing run
Amends: [Caller context in task selection](2026-10-06-caller-context-attachment.md), "identical context attaches", for a selection that holds a probing run
Amends: [A lens run is the model and level that ran](2026-11-08-lens-run-identity.md), "A review whose plan resolves to the same key reuses the stored run", for a selection that holds a probing run
Amends: [Capture the reasoning setting of each request](2026-10-18-reasoning-telemetry.md), "Repeating a review attaches to the same tasks", for a selection that holds a probing run
Amends: [A finished probing run is never reused](2026-11-14-probing-runs-not-reused.md), its status of the two gaps it put to the maintainer

Status: the host round on [pull request #296](https://github.com/melian-agent/melian/pull/296) at `464098a7` asked for these amendment lines in finding `95f88083f227ab35`. The coordinator asked for them in a pull request of their own after #296, on 2026-11-15. The Actions round on that pull request, [pull request #449](https://github.com/melian-agent/melian/pull/449), at `df7a7d3e` found two more in finding `41e436e8b42247a3`: lens run identity and reasoning telemetry. The coordinator reported on #296 that the maintainer read both gaps below and accepted them on 2026-11-15, in the coordinator's session, answering "agree" to the coordinator's recommendation.

Problem: [A finished probing run is never reused](2026-11-14-probing-runs-not-reused.md) means a repeat review of a selection with a probing run attaches to the lens task only while it is live. Once that task has finished, the repeat review creates a new lens task, replaces the old one in the index, probes again and runs every lens again. Nine older decisions say a repeat review attaches to the lens task, or to the verification after it, reuses the stored run, or spends nothing. Each still holds for a selection with no probing run.

Choice: for a selection that holds a probing run, each sentence now reads as follows.

- Review attachment: a repeat call attaches while the lens task is live, and never duplicates a live one. Once the task has finished, the repeat call replaces it, and the replaced task's review writes nothing more.
- Coverage ledger, item 8: a repeat review whose delta is empty attaches to the current decided round only when no lens task of the round holds a probing run. Otherwise it reviews again and pays for every lens.
- Enclosing functions: a repeat call attaches to the first call's live lens task and keeps its functions. After that task has finished, the repeat call renders the functions afresh.
- Triage: a finished lens task stays attachable only when its selection holds no probing run.
- Quiet review body, item 4: a repeat review keeps the first call's caveat when it attaches. When it runs a new lens task, the new task's caveat stands.
- Verify as each lens ends: a repeat review attaches to the verification it ran before only while it attaches to the same lens task. A new lens task gets new probe reruns, so the verification's key differs and it verifies again.
- Lens run identity: a review whose plan resolves to the same key reuses the stored run while that run is live. Once a probing run has finished, the review starts a new run, which replaces the stored one in the index. Its lineage describes the plan of the review that started it, as before.
- Reasoning telemetry: a repeat review attaches to the same tasks while its lens task is live. A repeat review that starts a new probing lens task gets that task's own stages, timing records and usage receipts, and they count in the review's spend. No timing record grows when a caller attaches or reads.
- Caller context in task selection: identical context attaches only to a live task. [Advisory caller context stays outside the lens task's attach key](2026-10-07-caller-context-outside-the-attach-key.md) has already replaced its caller section in the key.

The maintainer's reads of 2026-11-15, as the coordinator reported them on #296, settle the two gaps [the probing-runs decision](2026-11-14-probing-runs-not-reused.md) put to him:

- A probing task left live by a crash, and resumed by another build of Melian, continues under that build's prompts, role tools and sandbox, and nothing detects it. The host round's `eec2d1af20138592` named it. He accepted it.
- A repeat review of a selection with a probing run runs every lens again and pays for it. The host round's `95f88083f227ab35` named it. He accepted it.

Neither is a new ruling. Each accepts what the probing-runs decision gives up.
