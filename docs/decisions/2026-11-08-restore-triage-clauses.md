# Restore the triage clauses that partial supersessions retired

Amends: [2026-10-06-triage-cut-input.md](2026-10-06-triage-cut-input.md) and [2026-10-06-triage-clears-superseded-verdict.md](2026-10-06-triage-clears-superseded-verdict.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

[Triage as built](2026-10-05-triage-as-built.md) superseded [scrutiny levels](2026-10-04-scrutiny-levels.md) to change one sentence about escalation. [Cut input](2026-10-06-triage-cut-input.md) and [triage waits before lenses](2026-10-06-triage-waits-before-lenses.md) each superseded triage as built for one case. [Triage waits before adjudication](2026-10-06-triage-waits-before-adjudication.md) superseded the lens rule for adjudication alone, and [triage clears a superseded verdict](2026-10-06-triage-clears-superseded-verdict.md) superseded the adjudication rule for stored verdicts alone. The index retired each target whole. The clauses below still hold on main. This file restates them and changes nothing.

## From [2026-10-04-scrutiny-levels.md](2026-10-04-scrutiny-levels.md)

- A lens declares levels in `LENS.md`, `quick`, `careful`, and `deep`, each setting the model tier, token and tool budgets, the finding cap, whether it reads enclosing functions or hunks only, and whether its candidates are verified.
- When touched paths carry different bands, the highest floor and the lowest ceiling apply.
- A local cap below the repository's floor is an override and records as one.
- A lens that declares no levels runs only at `careful`, and triage's question for it collapses to skip or run.
- Escalation never exceeds the ceiling. A severe finding at the ceiling is reported with a note that escalation was capped.
- The manifest records the level each check ran at.
- The fast tier skips triage.

## From [2026-10-05-triage-as-built.md](2026-10-05-triage-as-built.md)

- A lens's key is `name@version@level`. Its findings' `source.version` is `<version>@<level>`.
- A record an older Melian stored keeps its keys and stays readable; no review after the upgrade attaches to it.
- A lens task an older Melian left running resumes with its runs' levels stripped, so its findings keep the bare version.
- Triage is one `melian.decision` task per revision and question set. A repeat review attaches to it.
- Only `rerun` asks again, and only after a decision that did not complete.
- A decider that fails, times out, or answers what it was not asked leaves every lens at its default level within its band, never at `skip`. Each lens's record says so.
- Triage offers only the levels inside a lens's band whose tier routes to a model with credentials. The band is read from the policy source for every file the lens reviews. A lens with no such level fails the review before any lens runs, and so do a lens whose default level has no model and a policy that cannot be read. A level triage could not offer is noted on the record.
- A review of a head the host does not trust has a default floor of `careful` until a calibrated decision model answers. That is a pull request, or a range whose policy is read from a revision. A range review of the checked-out commit keeps `quick`. A review in which every lens stayed at `quick` says so on each record.
- Escalation runs inside the lens task, in a new conversation the commit that records why creates. The run it escalated to stands for the lens: its record, with notes, and its findings.
- That run is given the quick run's findings at or above `escalateAt` to confirm or refute. A finding it restates counts once, from it. One it refutes is dropped. One it does neither still counts, attributed to the quick run, until the verifier judges it.
- An escalation whose next level's tier has no model is capped with a note.
- The CLI's LLM fallback runs on the first of the plan's lens tier routes, from `light`, with a credentialed model.
- The plan judges each lens at the level triage chose, and its escalation's next level. Its providers cover every level a lens declares.
- The review records every `decisions.*` check itself. With `decisions.provider` set, that record is a skip the review does not allow. The CLI refuses the provider before anything runs, until milestone 4 brings an adapter.

## From [2026-10-06-triage-waits-before-lenses.md](2026-10-06-triage-waits-before-lenses.md)

- A review waits for triage before choosing its lens selection.
- The decision commit removes any live lens task for that revision from the index, and the sweep aborts that task before the review waits.
- A stored answer or failure returns without starting the scheduler.
- A crashed run with a stored decision still resumes through `runLenses`.

## From [2026-10-06-triage-waits-before-adjudication.md](2026-10-06-triage-waits-before-adjudication.md)

- A pending decision removes the revision's adjudication task from the index in the same commit that removes any live lens task.
- The replacement sweep aborts unnamed adjudications before waiting. Their terminal commits also refuse to write once unnamed, covering a crash before the abort.
- A SQLite regression kills a review at adjudication, reopens with a held decider, and changes the selection. It checks that the old adjudication is aborted without writing, then that the new quick review's verdict stands after another resume.
