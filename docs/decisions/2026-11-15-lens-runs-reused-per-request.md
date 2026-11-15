# A lens run is reused by its request key, one lens at a time

Amends: [Restore the enclosing functions clauses](2026-11-08-restore-enclosing-functions-clauses.md), "The notes sit outside the attach key, as the blocks do", "The fingerprint renders the prompt without the blocks, and `selectionOf` holds none", and "A changed function read on the same head does not re-run lenses"
Amends: [Advisory caller context stays outside the lens task's attach key](2026-10-07-caller-context-outside-the-attach-key.md), the instruction fingerprint inside `selectionOf`
Amends: [A repeat review of a probing run attaches only while the run is live](2026-11-15-repeat-review-of-a-probing-run.md), a repeat review that runs and pays for every lens
Amends: [A finished probing run is never reused](2026-11-14-probing-runs-not-reused.md), "runs every lens of the review again, since one task holds them all", and the way out it left unbuilt
Amends: [Review attachment](2026-10-03-review-attachment.md), "a repeat call attaches, never duplicates", for a selection whose lens requests differ
Amends: [A lens run is the model and level that ran](2026-11-08-lens-run-identity.md), "A review whose plan resolves to the same key reuses the stored run", which now compares each run's request key
Amends: [Request keys as built](2026-11-14-request-keys-as-built.md), the lens task that attaches by `instructionFingerprint` and `selectionOf` until [issue #432](https://github.com/melian-agent/melian/issues/432)

Status: built for [issue #432](https://github.com/melian-agent/melian/issues/432). The maintainer ruled on 2026-11-14, in the coordinator's session, answering [issue #394](https://github.com/melian-agent/melian/issues/394)'s question about what joins the lens key, that enclosing functions join the lens run's request. The rest follows [the request keys decision](2026-11-14-request-keys-as-built.md) and is the builder's.

## Each lens run has a request key

Problem: the lens task attached by `selectionOf`, a list of each run's key and an instruction fingerprint. That fingerprint was a narrower list of what a lens is asked. It left out the tool descriptions, the injection policy and the failover wording, so a release that changed any of them reused a run asked under the old text. And one task held every lens, so a change to one lens's instructions ran every lens again. Example: on [pull request #436](https://github.com/melian-agent/melian/pull/436) the last round cost $30.16; a one-line edit to the conventions lens would pay all of it again.

Choice: `lensRequest` in `packages/pipeline/src/lens-request.ts` keys each run through core's `KeyedRequest.of`, producer `lens`. The request holds:

- the run as the lens task stores it, rendered under the fixed identity nonce: its name, version, level, route, thinking, budgets, instructions and prompt, the enclosing functions included;
- the injection policy that renders ahead of the instructions;
- every tool the run is offered, by name, description and schema, a probing run's planner and prober tools included;
- the wording a failover sends;
- the base and head, `escalateAt`, and the run a quick run escalates to by its key, or why it is capped;
- for a run that probes or escalates to another, the whole `probingWording` table, as rule 8 of [the identity guideline](../guidelines/identity.md) says: it holds the plan the prober reads, the prober's reminders, and the wording that carries a quick run's findings to the run it escalates to, which is copied only with it. Two reviews in a row found a string the key had left out when it picked fields from the table, so it keys the table whole. A changed probing string asks every probing or escalating lens again once;
- the standards it quotes, by their raw text, their source and whether they are trusted.

Left out, each with its reason:

- The review's nonce, which differs on every run.
- The caller section and the Enola graph its tools read, under `bestEffort`: a host whose graph query timed out would otherwise run every lens again, as [the caller context decision](2026-10-07-caller-context-outside-the-attach-key.md) found.
- The preference file's path in the standards' source, which names the host.

The index entry lists each run as `<key> request <request key>`. `selectionOf` is that list, sorted, and the instruction fingerprint is gone.

## Enclosing functions are keyed

By the maintainer's ruling of 2026-11-14, the enclosing functions a run is shown are part of its request. A repeat review that reads different functions on the same head runs those lenses again, and a lens whose level reads no functions is unaffected.

What it costs: a review that read the functions, crashed, and then could not read them on the retry, because the compiler would not start, renders other prompts. Its selection differs from the crashed task's, so the retry replaces that task and runs every lens again. Copying, below, reads only a completed task, and a crashed one is not. This is rare. The functions come from git and Melian's own compiler, both of which read the same commit the same way each time, so the read fails again only when the compiler fails to start, never by chance. `test/review-crash.test.ts` keeps the case.

## A new lens task copies the runs whose request it already answered

Problem: with every lens in one task, a review either attached to that task whole or ran every lens.

Choice: when a review's selection differs from the index entry's, the commit that creates the new lens task reads the task the entry names. When that task completed, `lensCopies` in `packages/pipeline/src/lens-reuse.ts` copies each lens whose first run has an earlier run's request key, if that run finished as asked:

- its status is done, with no budget end and no findings cap;
- it finished on a model the plan accepts;
- it does not probe;
- the run it escalated to, if any, finished the same way.

A copied lens carries its outcomes into the new task's input, each naming the task that asked it, and the nonce that task rendered its conversations under, both of which a copy of a copy keeps. Coverage reads a copied conversation under that nonce, since its quoted tool results carry that task's boundaries; read under the new task's nonce, a copied lens's reads were lost from coverage. It asks no model, and its sightings stay at the revision. Every other lens runs, and its earlier sightings are cleared in the same commit, as before. Version 7 of the lens task adds `reused` to the input and to each copied outcome; a version-6 task's runs have no request key, so nothing is copied from one. Telemetry shows a copied lens's stage as `reused`, with no tokens.

A probing run is never copied, so every finding it reports rests on a probe of its own review. A repeat review of a selection with a finished probing run now plans and probes again alone, and copies the review's other lenses. This is the way out [the probing-runs decision](2026-11-14-probing-runs-not-reused.md) named and left for [issue #427](https://github.com/melian-agent/melian/issues/427); only the copy is built here, not the hint.

## How the older clauses now read

- Enclosing functions: the functions and their notes are inside the lens run's request. A repeat call whose request matches attaches to the first call's task, or copies its run. A changed function read on the same head runs that lens again.
- Caller context: the caller section stays outside the key, now as the request's `bestEffort` part rather than through the instruction fingerprint.
- Review attachment: a repeat call whose every lens request matches attaches and never duplicates. One whose requests differ creates a task that copies the unchanged lenses from a completed task.
- Lens run identity: a review reuses a stored run when the run's request key matches, either by attaching to its task or by copying it.
- Probing repeat: a repeat review of a selection with a finished probing run runs the probing lens again, and pays for it alone. A crash after the lens task finished does the same.

## What this gives up

The first review of each head after this lands runs every lens once. Each index entry written before it lists its lenses without a request key, and a version-6 task's runs carry none, so nothing matches. At the size of [pull request #436](https://github.com/melian-agent/melian/pull/436)'s last round that is $30.16 per head; most rounds cost $3.57 to $9.85. A new push reruns every lens anyway, so only a head reviewed before the upgrade and again after it pays, once. `test/lens-requests-reopen.test.ts` opens a store main wrote and checks that each lens is asked once.

Lens records are not exported or imported between hosts here; rule 8 of [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md) can now key them by this request, in a build of its own.

Copying reads only the task the index names for the revision, so a lens changed and then changed back is asked again: the task that held its first answer has been replaced.
