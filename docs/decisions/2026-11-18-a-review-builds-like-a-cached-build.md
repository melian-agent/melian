# A review builds like a cached build

Amends: [Every key follows one guideline](2026-11-13-keys-follow-one-guideline.md), rule 1's table: each row also names the class of every input its key leaves out, and each rule about what is considered equivalent sits beside the key it shapes, with a test.

Status: the maintainer asked for this decision on 2026-11-18, in the coordinator session, for [issue #568](https://github.com/melian-agent/melian/issues/568). The coordinator drafted it, and the maintainer ruled on each of the draft's nine choices that day, in that session, as [the coordinator's comment on issue #568](https://github.com/melian-agent/melian/issues/568#issuecomment-6967840315) records. Each choice is stated below as the rule. [The audit](../research/2026-11-18-stored-results-against-the-build-model.md) for [issue #569](https://github.com/melian-agent/melian/issues/569) is the evidence for "What this asks of the code today".

## Problem

Melian reuses work. A lens that already read a change is not asked again, a static check that already ran is not run again, and a verdict is decided again from what is stored. Each reuse rests on a claim that what is stored is what this review would have produced. Melian makes that claim in two different ways, and the defects come from the second.

Its requests are keyed by a hash of what they ask. Its shared record is addressed by the hash of each record's content, and nothing in it is overwritten. But its local store keeps results in documents addressed by something else, such as a revision and a check's name, and replacing a value there is an ordinary write. Whether a stored result still counts is then decided by a rule that inspects the store.

## Examples

- Two runs of a static check review one revision under different settings. The later one to finish replaces the other's findings. A review that reuses the first run's finished task then reads the second run's empty result, and passes ([issue #562](https://github.com/melian-agent/melian/issues/562)).
- A request Melian knows it cannot describe fully, such as one whose install it could not identify, still has a key, and a result was vouched for under it ([pull request #557](https://github.com/melian-agent/melian/pull/557)).
- The policy fingerprint left out, in turn, that a branch name can move, that git can replace an object, and that Melian's own built-in defaults change with an upgrade ([pull request #525](https://github.com/melian-agent/melian/pull/525)).
- Version numbers raised by hand decide what is reused, and two pull requests can raise one to one value ([issue #437](https://github.com/melian-agent/melian/issues/437)).

Each was fixed where it appeared. They are one mistake: a result stored where its producer's key does not reach, or a key that does not cover what the result depends on.

## The model

The maintainer's words, on 2026-11-18, in the coordinator session: "I feel like we keep making the same kind of mistake over and over again, the model I was imagining is closer to the way docker build works, which can lazily get to a deterministic state by building whatever is missing, reusing what is the same. The main difference is what is 'the same' is a bit different in our case."

1. **Every step has a key.** A lens run, a static check, a verification, triage, a probe and the walkthrough are steps. A step's key is a hash of everything its result depends on.
2. **A result lives under the key of the request that produced it.** It is written once and never overwritten. A different result under an identical key is a second result, kept beside the first.
3. **Reuse is a lookup.** A review asks the store for a key. A hit is reused and a miss is run. No rule inspects stored state to decide whether a result "still stands".
4. **A review is a walk.** It names the steps the base's policy asks for, looks each one up, and runs what is missing. Two reviews of equivalent inputs reach one set of results, whichever runs first and whatever each finds already there.
5. **A verdict is computed, not stored into.** It is a function of the results a review read and the base's policy. It lists what it read. It is not a place results are written.

## Where a review differs from a build

### A step is not deterministic

A lens asked an equivalent question twice can answer differently. The maintainer ruled on 2026-11-16 that "Whether probing or not, a lens with the same running parameters (including the fact that it is a probing lens) on the same code, should not be run again", as [the probing reuse decision](2026-11-16-finished-probing-runs-are-reused.md) records. On 2026-11-18 the maintainer ruled that the gate takes the findings of every round at a head together, as [the coordinator's comment on issue #395](https://github.com/melian-agent/melian/issues/395#issuecomment-6964346733) records. So one key normally holds one result, and when it holds more, all of them count.

A rerun is asked for by name and adds a result under its key. It never replaces one. The findings of every result under a key are taken together; the maintainer's words were "Agree, finding combined". Nothing reruns a step because an earlier answer was unwelcome.

### What is considered equivalent is policy

A build compares bytes. A review decides which inputs are considered equivalent, and each such choice is a rule a key carries out by normalising its inputs before it hashes them:

- A fallback model a route allows is equivalent to its first, by the maintainer's ruling of 2026-11-18, which [the gate's build plan](https://github.com/melian-agent/melian/issues/395#issuecomment-6964797545) records. So a step's key names the route, and the model that answered is recorded beside the result, not in the key. Where a fallback is not yet equivalent in practice, the answer is to make it so, or to measure why it is not, never to key by model. The maintainer's words: "Agree. We should bump the fallback's budget/thinking level so it is equivalent, or have a separate eval loop to understand why they aren't." [Pull request #536](https://github.com/melian-agent/melian/pull/536) gives a fallback its own thinking level, and [issue #555](https://github.com/melian-agent/melian/issues/555) is the measurement.
- A finding that moved within a file is equivalent to the finding it was. Its ID hashes its file, rule and normalised snippet, not its line.
- A dismissal holds while its trigger, or the hunks that proved its cause, are unchanged.
- A finding counts for a merge only when a file it proves on is in the diff that merge adds, by the maintainer's ruling of 2026-11-18, which [the coordinator's comment on issue #395](https://github.com/melian-agent/melian/issues/395#issuecomment-6964759384) records.

Every such rule is written in [the identity guideline](../guidelines/identity.md) beside the key it shapes, with a test in which that rule alone decides whether two inputs are equivalent and so share a key.

### Inputs are hard to pin

A build pins its inputs with a base image and a context. A lens also depends on the installed dependencies, the sandbox, the provider's model behind a name, and Melian's own build. For every input of every step, exactly one of four holds, and the identity guideline says which:

- **In the key.**
- **Sealed out.** The step runs so that the input cannot affect its result.
- **A named limit.** A result that depends on it is not vouched for beyond the run that made it: it is not reused by another review and not shared with another host.
- **Left out by a ruling that names the risk.** The result is reused regardless. The maintainer ruled so on 2026-11-16 for the installed dependencies of the code a probing run tests, and on 2026-11-15 for `PATH`, `HOME` and `TMPDIR` under mutation, on the host that ran the run. Each such ruling is listed in the guideline beside its key.

An input in no class is a defect.

### People are inputs

A dismissal is a record. It names who made it, it is never changed, and a later dismissal replaces it only by naming it in `supersedes`, as rule 7 of [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md) sets out. A writer records a read of an acknowledge finding as a dismissal with its reason, by rule 9 of that decision. The verdict consumes dismissals as it consumes a lens's findings. The outage override stays what [the outage procedure](2026-10-23-melian-review-outage-procedure.md) makes it: a status on one commit, which the merge-group check reads.

### A store can be written by whoever can reach it

The model says where a result lives, not that it is honest. The local store is trusted as the machine is. The shared record is trusted as write access to its branch is, by rule 6 of the shared record decision. The branch sits behind the `melian-state` ruleset, which refuses its deletion and any push that is not a fast-forward, with no bypass, as [issue #463](https://github.com/melian-agent/melian/issues/463) asked. A key or a stamp shows that a result was produced under a request, to anyone who cannot write the store. It shows nothing to someone who can.

## Why

A rule that inspects state has to be right about every way the state can have come about, and each defect above is a way nobody listed. A lookup has one question to get right: does the key cover the inputs. That question can be asked of each step once, in the guideline, and tested.

## Step 24, coverage and delta review

Re-reviewing only what a fix changed is not a new goal of this decision. It is plan step 24, which [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md) settled on 2026-10-23, and this decision changes nothing in it. The model bears on it in two ways: a lens's result can be reused when nothing it covered changed, and the coverage ledger is computed from records, as [the design](../design.md#concepts) already says of the record.

## What this asks of the code today

[The audit](../research/2026-11-18-stored-results-against-the-build-model.md) read every place Melian stores a result, at `main` on 2026-11-18. It found 78 stored things. 30 follow the model and nothing else. 19 can give a wrong answer that lets something through, which the audit calls failing open, and 3 of those need someone who can write the store.

- **The shared record's mechanics follow the model.** A record's ID is the hash of its bytes, and no adapter overwrites one. The relay ([issue #397](https://github.com/melian-agent/melian/issues/397)) and the gate ([issue #395](https://github.com/melian-agent/melian/issues/395)) are not built, and the one reader that exists reads record fields alone. But a check, lens or verification record copies what the local findings document holds for its producer at its revision, not what the run its key names produced. So a reader of records inherits the local store's slots.
- **The local store does not follow it.** The findings document keeps every sighting, verification and dismissal in a slot by revision and producer, which every run of that producer writes. A static check run that finishes late can empty another run's blocking finding there, and the review passes ([issue #562](https://github.com/melian-agent/melian/issues/562)). Of the 16 rows that fail open without a store writer, 8 turn on code that no key holds; [issue #437](https://github.com/melian-agent/melian/issues/437) covers all of them but adjudication.
- **Five fail-open rows have no issue yet.** C8: the adjudication attach key holds no adjudication code, so after a release that blocks more, a repeat review prints the old pass. C5: a dismissal holds when its finding returns more severe with an unchanged trigger. A3, in part: a Bun install counts as identified, though the check request keys only Bun's lockfile. D9: the round reader never checks a named record's revision, so a planted round can count another head's records. A13: a self-consistent Enola graph planted in the state directory can drop Enola findings.

The direction is to write a record where its result is produced, and to make the verdict a review prints and the verdict the gate computes one function, over one set of records. The local documents become indexes that can be rebuilt from records. This is done after the gate lands, in steps the audit's ranking orders, and not as one rewrite. The order is the audit's rows that fail open, then one verdict function, then finer lens keys. Until each step lands, the decisions that describe today's behaviour stay true of the code, and the step that changes one amends it.

Until then, no new proof or patch is added to the export seam beyond [pull request #557](https://github.com/melian-agent/melian/pull/557) and [issue #562](https://github.com/melian-agent/melian/issues/562). A further instance found there is recorded against the audit, not fixed in place.

## What this does not change

- The rulings it restates. It gathers them under one model and overrules none.
- Pi Durable's version numbers on stored documents and tasks, which its migrations read. Where a hand-raised number decides reuse, the maintainer ruled on 2026-11-16 that Melian records hashes instead, as [the coordinator's comment on issue #437](https://github.com/melian-agent/melian/issues/437#issuecomment-6906681894) records.
- Budgets, levels and routes. Making a fallback equivalent is the work of pull request #536 and issue #555. The rest belongs to the parity work in [pull request #508](https://github.com/melian-agent/melian/pull/508).

## Limits

- The model does not make a step's answer right. A rerun can add a finding a first answer missed. It cannot remove a wrong finding; a dismissal does that.
- A step that cannot be keyed fully is a named limit: it runs again on every review, and its result is shared with no one. Today a check run whose install Melian cannot identify, such as a checkout with a lockfile and no install, is never reused.
- Whoever can write a store can plant a result in it.
