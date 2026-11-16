# A review resumes from the records it imports

Amends: [the shared record decision](2026-11-13-shared-record-behind-a-store-port.md), rule 4's import of several records under the key a host's own run would use

Status: for [issue #475](https://github.com/melian-agent/melian/issues/475). A builder's design. The coordinator answered its questions of approach on 2026-11-16, in the coordinator's session; those answers are not rulings. The amendment of rule 4 is the maintainer's: the maintainer ruled on 2026-11-16, in the coordinator's session, that the import runs a producer again when two records under one key disagree, as [the coordinator's comment on issue #475](https://github.com/melian-agent/melian/issues/475#issuecomment-6913031913) records.

## Problem

[Rule 8](2026-11-13-shared-record-behind-a-store-port.md#8-another-host-resumes-by-completing-the-manifest) says another host resumes by building its own requests, importing the records whose keys match, and running only what lacks one. Until now `--records` only exported. A second clone that reviewed the same pull request asked every model again: for a recent Melian round that is $3.57 to $9.85 spent on answers the store already held.

## Decision

A review that names a record store, under a base that sets `trust.writers: true`, reads the changeset's records before anything runs. Each producer then asks the import for its own request, and runs only when nothing answers it.

### What an import counts

A record counts when its envelope names the changeset under review and its kind is one a producer asks: `check`, `lens`, `verification`, `walkthrough` or `triage`. A round, an account, a dismissal, telemetry and every kind a command writes are set aside before their payloads are read. This host writes its own account and round.

Two rules settle version skew:

- **A payload of a later version than this build reads is set aside, and its producer runs.** A newer build's record must not stop an older build's review of the same changeset.
- **A counted record of a version this build reads, whose payload its check refuses, fails the whole set.** The review stops before anything runs. A record that claims a known shape and breaks it is damage or forgery, and standing on the rest would hide it.

These are additions: no clause of the shared record decision spoke to a payload's version.

### What a match is

A producer matches a record by its kind, its revision, `base..head`, and its key. So a record of another base or head under the same key answers nothing. A key is the hash of the request, so a record whose key names another request answers nothing either.

Rule 4 said a host that finds several trusted records under its key imports all of them and merges their sightings. This build runs the producer instead, unless the records agree on everything but the check a review decided for them. Two runs of one lens can differ, and a clean record must never hide one with findings; running again is the one answer that cannot. Merging can come for a lens run once its stored form holds several outcomes. This is the amendment above, by the maintainer's ruling.

### What each producer stands on

- **A check** stands on a record of a check that ran. One that failed, skipped or was provisional runs again. `static.mutation` never reuses a record, since [the mutation amendment](2026-11-15-check-run-keys-lang-under-mutation.md) keeps it for the host that ran it, and neither does a run that left caller snapshots, which a record cannot restore.
- **Verification** stands on one record only when it answers the request whole: every candidate done, by a model this host does not refuse, and every claim judged. Short of that the verifier runs for every candidate. While such a record covers the revision, the waves that verify as each lens ends are skipped, since their keys differ from the final request's.
- **Triage** stands on a record only when its answers still parse against the request's questions and each chooses what its distribution favours, and only when this host has made no decision of its own for the revision. A decider that failed answers nothing. The import writes no entry in this host's decisions, and clears what a new decision would, so a repeat review on that host asks again rather than trusting a choice it never made.
- **A walkthrough** stands on a record written on the light route this host would ask, and never under `--rerun`, which asks for a walkthrough of its own.
- **A lens** stands on records only when every run it ended on has one: a run of the same lens, version and level under its request's key, which finished within its budgets, was not capped at its findings budget, did not probe, and ran on a model this host does not refuse. A quick run that escalated stands only beside a record of the run it escalated to. A lens this host's own earlier task already answers copies from that task instead. The lens task's input names an imported copy by its record's ID, with no task or nonce, and each imported outcome names that record as `imported`; lens task version 8 adds that form, and its migration is the identity. The import writes the record's findings under the lens's source, charges the lens nothing, and leaves it out of the coverage this host records, since no conversation of its read a line.

A host exports the record it stood on, byte for byte, so its round's `read` names the same ID the first host's did.

### What is never reused

Mutation records, as above. A finished probing run. Dismissals: an imported dismissal is not applied, which is [issue #506](https://github.com/melian-agent/melian/issues/506). Line mapping and voids, which a host recomputes from git, as rule 8 requires.

## What a writer of the store can make a review skip

A record counts because the store accepted it, by rule 6, so anyone who can write the store can plant one under a key a host will build. Today, under `trust.writers: true`, such a writer can make a review:

- keep a clean check it never ran;
- stand on verdicts the verifier never gave, confirming or refuting a finding;
- post a walkthrough no model wrote;
- stand on a lens run no model made, with the findings the record lists or none, so that lens asks no model;
- take a triage decision this host never made, where this host has made none for the revision: any option each lens's band offers, the lowest level included, and `skip` for a lens whose band's floor is `skip`, which then does not run. A lens whose floor is above `skip` still runs at its floor or above, since a record that chooses an option its question does not offer answers nothing.

That is the trust a writer already holds: the same writer can push the code under review. A base that sets `trust.writers: false` imports nothing, and the CLI says so. Signatures, [issue #371](https://github.com/melian-agent/melian/issues/371), close the gap for a repository that does not trust its writers, since such a base counts only records its pinned key signed.

## Tests

Unit tests plant each record the coordinator named, and show what each answer is:

- a record whose envelope names another changeset is set aside, whatever its payload holds;
- a record of another base or head under the same key answers nothing;
- an ID that does not match its record's content fails the directory store's `list`;
- two disagreeing records under one key answer nothing, so the producer runs;
- an imported kind written with a round's or an account's key answers no producer's request;
- a payload of a later version is set aside, and one of a known version that breaks its shape fails the set.

Per producer, a planted record under another key, or one that does not answer whole, makes the producer run. For a lens, so does a record that ended at a budget, was capped, probed, ran at another level, or did not finish. A lens copy that names a record and no task or nonce covers no line, and a review killed after it imported a lens resumes with the imported outcomes and asks that lens nothing. A version-7 lens task, recorded by main, reopens under version 8 and a new task copies its run. A test in the CLI runs a second clone from the first's store and shows its round reads a check record the first never wrote.
