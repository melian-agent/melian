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
- the injection policy that renders ahead of the instructions, and the name of the Pi section it renders in, which Pi writes as its tag;
- the installed versions of Pi Durable and pi-ai, read from each package's own `package.json`. Pi Durable renders the system sections, with their tags, and writes the turns Melian does not, such as a cut tool result's note; pi-ai turns the conversation into each provider's request, which decides, for one, whether the brief arrives as instructions or as a message. Either can change what a lens is shown with no change to Melian's text;
- every tool the run is offered, by name, description, schema, output limits and argument bound, a probing run's planner and prober tools included, and `lensToolLimits`, the bounds every lens tool cuts what it shows to. A limit decides what a lens is shown, as its description does;
- the wording a failover sends;
- the base and head, `escalateAt`, and the run a quick run escalates to by its key, or why it is capped;
- for a run that probes or escalates to another, the whole `probingWording` table, as rule 8 of [the identity guideline](../guidelines/identity.md) says: it holds the plan the prober reads, the prober's reminders, and the wording that carries a quick run's findings to the run it escalates to, which is copied only with it. Two reviews in a row found a string the key had left out when it picked fields from the table, so it keys the table whole. A changed probing string asks every probing or escalating lens again once;
- the standards it quotes, by their raw text, their source and whether they are trusted.

Left out, each with its reason:

- The review's nonce, which differs on every run.
- The caller section and the Enola graph its tools read, under `bestEffort`: a host whose graph query timed out would otherwise run every lens again, as [the caller context decision](2026-10-07-caller-context-outside-the-attach-key.md) found.
- The preference file's path in the standards' source, which names the host.
- The lens tools' own code: the text each tool returns to the model, what each tool does, and the lens extension that runs the conversation. The maintainer ruled on 2026-11-15, in the coordinator's session, to leave it out until [issue #437](https://github.com/melian-agent/melian/issues/437) ties a code version to a hash of `lens-tools.ts`, the extension and core's revision readers, in a test. A request is data, and rule 8 of [the identity guideline](../guidelines/identity.md) forbids hashing source at run time. Until then, a change to what a tool returns, with its description and schema unchanged, reuses runs asked under the old code. Only a new base or head asks again, or a probing lens, whose finished run is never reused: `--rerun` asks only lenses that failed, so it leaves a finished run in place.
- Chord, Pi's composition runtime, which shows a model nothing.
- The packages Pi Durable and pi-ai depend on. The key names those two by their own versions alone. The maintainer accepted this on 2026-11-15, in the coordinator's session; the costs below say why.

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

## A copy needs the same callers

Problem: a lens task stores one record of the callers its lenses were shown: each lens's notes, the caveat that says no lens saw who calls the changed code, and the key of the call graph they came from. Once a task held copied runs beside new ones, that record described the new review alone. Four reviews found four instances. A copied lens lost its own notes; it lost the earlier caveat; it gained a caveat that said no lens saw callers when it had; and its coverage claimed a graph its model never saw, after Enola was upgraded for the same tree.

Choice: a review copies runs only from a task shown the same callers as it. `callersShown` in `packages/pipeline/src/review.ts` takes that from each stored record: the graph's key, `GraphSnapshot.key` of the record's coverage parts, and the caveat. A review without Enola stores no record, and matches only another without one. When they differ, the review asks every lens again, so a task mixes runs only when one caller record is true of them all. The coordinator chose this on 2026-11-15, in its session, as a choice of approach rather than a ruling, and told the maintainer.

Left out of the match:

- The cache root, which names the host.
- The paths, which follow the revision, and a copy already shares it.
- Each lens's notes. A file's caller query can fail in one review and not the other with the same graph and caveat, so a copied lens keeps its notes from the task that asked it.

What it costs: a repeat review of a head asks every lens again when Enola's availability, or the graph's key, changed between the two reviews. Both are rare. The first needs Enola to fail, or the host to supply no graph, in one review only. The second needs an upgrade of Enola, the compiler or Enola's configuration, which rebuilds the graph for the same tree. The request key is unchanged, so callers stay best effort, as [the caller context decision](2026-10-07-caller-context-outside-the-attach-key.md) says. Keeping a caller record with each copied run would copy more often, but it changes the lens task's stored shape; [issue #437](https://github.com/melian-agent/melian/issues/437) can weigh it as a later gain.

## A commit acts only on what its read found

Problem: a review unlocks credentials before the commit that attaches or copies, from a read of the review index. When it reads that it will attach, it unlocks nothing, since a live task's providers were unlocked when it resumed and a finished task asks no model. When it reads that it will copy, it unlocks only the providers of the lenses it will ask. Another review can commit between the read and the commit. Two reviews of record on [pull request #466](https://github.com/melian-agent/melian/pull/466) each found a path through that gap. A review that read it would copy attached to a task another review had created. A review that read it would attach attached to the task a `--rerun` had created in its place. Either way, a lens could run with its provider's credential command never run.

Choice: the commit acts only on what its read found: the task it read it would attach to, or the lenses it read it would copy. Any other outcome writes nothing, and the review commits again with every provider unlocked, which may then attach or copy whatever it finds. The coordinator chose this on 2026-11-15, in its session, as a choice of approach, and told the maintainer.

Where it holds: the rule holds today for lens commits in `runLenses` alone. The other read-ahead unlocks predate it: triage's in `review.ts`, the final verification's and each wave's in `verification.ts`, and the walkthrough's in `summarize.ts`. Triage's is known to break it. The review of record at b24d2672 had a first review's triage fail, then a `--rerun` review replace the failed decision task while a second review was between its read and its commit. The second review attached to the new live task with its triage credentials never unlocked. [Issue #474](https://github.com/melian-agent/melian/issues/474) brings every such site under the rule, or says why one needs no change. The coordinator scoped it out of this pull request on 2026-11-15, in its session.

## How the older clauses now read

- Enclosing functions: the functions and their notes are inside the lens run's request. A repeat call whose request matches attaches to the first call's task, or copies its run. A changed function read on the same head runs that lens again.
- Caller context: the caller section stays outside the key, now as the request's `bestEffort` part rather than through the instruction fingerprint. A copy also needs the earlier task to have been shown the same callers, as above.
- Review attachment: a repeat call whose every lens request matches attaches and never duplicates. One whose requests differ creates a task that copies the unchanged lenses from a completed task.
- Lens run identity: a review reuses a stored run when the run's request key matches, either by attaching to its task or by copying it.
- Probing repeat: a repeat review of a selection with a finished probing run runs the probing lens again, and pays for it alone. A crash after the lens task finished does the same.

## What this gives up

The first review of each head after this lands runs every lens once. Each index entry written before it lists its lenses without a request key, and a version-6 task's runs carry none, so nothing matches. At the size of [pull request #436](https://github.com/melian-agent/melian/pull/436)'s last round that is $30.16 per head; most rounds cost $3.57 to $9.85. A new push reruns every lens anyway, so only a head reviewed before the upgrade and again after it pays, once. `test/lens-requests-reopen.test.ts` opens a store main wrote and checks that each lens is asked once.

Lens records are not exported or imported between hosts here; rule 8 of [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md) can now key them by this request, in a build of its own.

Keying the Pi versions has a cost: an upgrade of Pi Durable or pi-ai asks every lens again once, on the next review of each head, as a first review does. The maintainer accepted that on 2026-11-15, in the coordinator's session. A Pi release can change what a lens is shown with no change to Melian's text: before Pi Durable 1.1.0, every lens brief reached openai-codex as a trailing developer message, and from 1.1.0 it is the system instructions.

The key does not name the packages beneath Pi Durable and pi-ai, and those can change how a request is built. Example: pi-ai 1.1.0 pins `@aws-sdk/client-bedrock-runtime` 3.1127.0, and that client takes `@aws-sdk/core` and `@smithy/core` through caret ranges. A reinstall can resolve newer AWS and Smithy releases that build Bedrock requests differently, while pi-ai still reads 1.1.0, and a review after it copies a lens run the old code asked. Hashing the lockfile or npm's install records, as a check run's key does, would cover it. It was rejected because a check reads the install itself, while a lens reaches it only through a model request: the key would change whenever any dependency moved, a test runner or a linter included, and every lens would run again. [Issue #470](https://github.com/melian-agent/melian/issues/470) keys only the packages on the path from Pi to a provider's request.

Copying reads only the task the index names for the revision, so a lens changed and then changed back is asked again: the task that held its first answer has been replaced.
