# Hosts share a record of facts behind a store port, and working state stays where it ran

Supersedes: [the state branch decision](2026-11-07-state-branch-storage.md)
Amends: [the coordination decision](2026-11-08-how-melian-coordinates.md), rule 2's lease on the state branch and rule 3's fence on `melian/review`
Amends: [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md), its "Sharing, for milestone 3" section
Amends: [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md), its "Fork heads" section: a record the trusted host's key signed covers a fork's head
Amends: [melian/review on merge groups](2026-10-22-melian-review-on-merge-groups.md), what the merge-group check reads
Amends: [the melian/review outage procedure](2026-10-23-melian-review-outage-procedure.md), when the merge-group check recognises a maintainer's override
Amends: [marker trust](2026-10-03-marker-trust.md), what proves a marker
Amends: [publication round binding](2026-10-18-publication-round-binding.md), which round a publication binds when several stand
Amends: [the publication triage guard](2026-10-19-publication-triage-guard.md), its check that the bound round is the revision's current round
Amends: [the rounds decision](2026-10-18-compare-rounds-exact-rule.md), a round's ID, the current round, and what a frozen round means once hosts share rounds
Amends: [comparisons by round](2026-10-21-comparisons-by-round-as-built.md), the ID a comparison names its round by
Amends: [run details bound to the round](2026-10-27-run-details-bound-to-round.md), the ID a run snapshot is stored under
Amends: [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md), its "A round over the ledger" and "Round identity and attachment" sections, where they order rounds by mint
Amends: [the Actions round's status](2026-11-07-actions-round-sets-melian-review.md), what an Actions round writes, what the merge queue reads, and its exemption for an unresolved acknowledgement once the gate is the required check
Amends: [dismissal carries to a restatement](2026-11-08-dismissal-carries-to-restatement.md), how an inheritance is held and which dismissals are roots
Amends: [the finding register](2026-10-24-finding-register.md), where the language line's exclusion from a key is written
Amends: [owed thread returns](2026-10-18-owed-thread-returns.md), where the reply journal and owed resolutions live
Amends: [dismissal](2026-10-04-dismissal.md), where a dismissal lives, who may write one, how a later one replaces an earlier, and what `dismiss` does offline
Amends: [Actions complete the manifest](2026-10-04-actions-complete-the-manifest.md), the form a local record takes, and its single-writer rule

Status: adopted. The maintainer adopted it on 2026-11-13, in the coordinator's session ("lets adopt 377"), after eight review rounds and a sweep against every active decision. Not built: step 46's builds each test the rules they implement, and amend this file where a build shows a rule wrong. The maintainer asked for it in the coordinator's session that day, after a review of the design's gaps in durable state, and gave four directions there: nothing may rely on one provider's features; the contract must not assume git; distributing keys must need no logistics; and a dismissal counts only from a writer. Six spikes tested the first draft, under [issue #368](https://github.com/melian-agent/melian/issues/368). Three reviews then tested that draft with unit tests, as [the convergence rules](2026-10-15-review-loop-convergence-rules.md) require of a ruling on trust, and this text answers what they found.

## Problem

A changeset's Pi storage holds two things. Working state is task checkpoints and lens transcripts: large, one writer's history, impossible to merge, and useful only to the run that wrote it. The record is what another host needs: check and lens results, verifications, rounds, dismissals, posts and adjudications.

The state branch shipped both as one log, and each of its hard parts followed from that:

- The log cannot merge, so one writer held a two-hour lease.
- The publisher's marker secret sat inside it, so every file was sealed under a writers' key.
- `melian/review` was to carry the lease's generation. Any write raises the generation, a dismissal or a comparison included, so a queued pull request's passing status would stop matching. Three rounds on [pull request #314](https://github.com/melian-agent/melian/pull/314) found that fence missing in three forms.
- Transcripts rode along. Of 67 pull-request stores on the coordinator's host, 9 pass 100 MB and the largest is 1.1 GB, past what a git host accepts in one file.

Example: the record documents in those 67 stores come to 56 MB of 4,226 MB, counting every revision ever written. The largest pull request's is under 5 MB.

## What the spikes showed

| Spike | Result |
| --- | --- |
| [Issue #373](https://github.com/melian-agent/melian/issues/373) | A verdict computed from record files alone is byte-equal to the stored one, for a passing round, a blocking one, one not reviewed, and after a dismissal. |
| [Issue #372](https://github.com/melian-agent/melian/issues/372) | A fresh store seeded from records ran only the lens and check the first store lacked, and reached the same verdict, through Pi Durable's public surface. |
| [Issue #369](https://github.com/melian-agent/melian/issues/369) | A scripted review's record is 22 KB of a 381 KB store. The only secret in the store is the marker secret. |
| [Issue #370](https://github.com/melian-agent/melian/issues/370) | One conformance script passes on a git adapter and a directory adapter. A cloud session can push a branch, and cannot write `refs/melian/*` or delete a ref. |
| [Issue #371](https://github.com/melian-agent/melian/issues/371) | Ed25519 signatures verify against keys from a base commit, and each forgery is refused. |
| [Issue #374](https://github.com/melian-agent/melian/issues/374) | A cloud session can post reviews and comments. It cannot set a commit status or resolve a thread. |

The spikes ran small scripted reviews on the fake model, and their builders reported them. Each also said where the first contract was wrong; the decision below takes those corrections.

## Decision

### 1. Working state stays on the host that runs

Pi's storage, with its checkpoints and transcripts, is local: SQLite in a clone, thrown away on a runner. A crash resumes from Pi's checkpoints on the same host, as today. No host ships it to another.

So a comment command reads the record, never a session. The interaction model called each command "a submission into the changeset's conversation", and on another host that conversation is gone. Resolving a thread, dismissing from one and re-reviewing need only records, git and the provider. "Explain this finding" is a fresh request over the finding, its evidence, the verifier's reason and the code; it cannot say what the lens read and ruled out. "Focus on a path" and any other steer reach a running review only on the host running it, and elsewhere they are input to the next round. The maintainer ruled so on 2026-11-13, in the coordinator's session. When milestone 4 builds "explain", a lens record may gain a bounded trace of what the lens read, beside its delivery evidence; that is a later decision.

### 2. Hosts share the record

The record is a set of immutable facts, one per record. A review writes five kinds: a check's result, a lens run's sightings, a verification, a walkthrough and a round, with optional telemetry. An inheritance is no kind: rule 9 computes it. Five kinds come from a command, never from a review: a dismissal, a marker, a post, a status and the ledger comment, with a comparison beside them. [Issue #369](https://github.com/melian-agent/melian/issues/369)'s table sorts every document Melian stores into a kind or into working state.

A host adds a review's records in batches as its tasks finish, one batch at a time, and the round's closing record last. The record has no single writer: [Actions complete the manifest](2026-10-04-actions-complete-the-manifest.md) made a local publish wait for a running Action, and here hosts add at once, since adding never overwrites. A runner its concurrency group cancels has shared the batches it finished, and nothing waits on it. So a runner that dies has already shared every lens and check it finished, and its successor reruns only the task that was cut.

### 3. The record store is a port

Core defines it, and git is its first adapter. A memory adapter serves tests and a directory adapter proves the contract leaks nothing of git. Every adapter runs one conformance suite, as Pi's storage adapters run Pi's.

```ts
type RecordEnvelope = {
  v: 1;
  changeset: string;
  revision?: string;
  kind: string;
  key: string;
  supersedes?: string[];
  payload: JsonValue;
  signer?: string;
  signature?: string;
};

interface RecordStore {
  add(records: RecordEnvelope[]): Promise<void>;
  list(changeset: string): Promise<RecordEnvelope[]>;
  readCell(changeset: string): Promise<{ value?: string; version?: string }>;
  writeCell(changeset: string, expectedVersion: string | undefined, value: string): Promise<boolean>;
  dispose(changeset: string): Promise<void>;
  close(): Promise<void>;
}
```

The envelope is strict, because [issue #371](https://github.com/melian-agent/melian/issues/371) and [issue #378](https://github.com/melian-agent/melian/issues/378) each found one fact taking several IDs:

- A record's ID is the SHA-256 of its envelope's canonical bytes, and canonical bytes are RFC 8785 (JCS). Every number is a safe integer, and an amount is an integer in the smallest unit its payload names.
- An envelope holds these fields and no other.
- `changeset` and `kind` are one or more segments of `[a-z0-9-]` joined by single dots. An adapter hashes `key`.
- `revision`, when present, is two full lower-case object IDs joined by `..`.
- `supersedes`, when present, is a non-empty, sorted list of distinct 64-hex IDs.
- `signer` and `signature` appear together or not at all. A signature is 64 bytes in canonical base64, over the canonical bytes of the whole envelope without `signature`.

The store promises this much and no more:

- `add` can be repeated: the same bytes twice are one record. A batch may land in part, and a repeat completes it.
- `list` is fresh: it returns every record whose `add` returned before the call. A store that can only answer from a stale copy fails the call, and is no record store. The first draft let `list` be stale, and each rule built to survive that, a cell naming the rounds, a watermark for publication, was a new thing to forge.
- `readCell` is fresh: it returns the last value a `writeCell` stored.
- `writeCell` succeeds only when the cell's version is still `expectedVersion`. A version is opaque and changes on every successful write, never a hash of the value, and a writer that dies leaves nothing that blocks the next. The conformance suite holds the case of a value that went away and came back.
- `dispose` first writes a disposal mark to the cell, and `add` refuses a changeset whose cell holds one. Disposal is permanent: the port has no way to recreate a changeset, since one would need an incarnation every record and writer carries.
- It promises no ordering of records, no history, no transaction across records, no secrecy, and no identity for a writer.

The cell holds one small JSON value: the publication lease and the disposal mark. No verdict reads it.

### 4. Nothing a verdict reads is chosen by a hash

The first draft settled two records in one slot by the lowest ID. [Issue #378](https://github.com/melian-agent/melian/issues/378) showed a writer could grind an ID to win a slot, and Melian's own design lens showed two honest hosts losing a blocking sighting that way, since two runs of one lens can differ. So:

- **A round names what it rests on.** Its closing record lists the kind, key and ID of every record it read, its walkthrough or that it has none, the earlier rounds of its revision it replaces, and the rounds of the revision before. A record a round names counts for that round. One that does not match the named kind, key and ID together counts as not found, and a round with a record not found reads as not reviewed.
- **An import keeps every record.** A host that finds several trusted records under the key its own run would use imports all of them, and their sightings merge as two lenses' sightings do. Nothing is dropped. The merge keeps [its order](2026-10-16-merge-by-shared-cause.md), the most severe as reported and then the lens. Two runs of one lens tie on both, and the record's ID breaks that tie. Every claim is kept and the highest severity among them counts, so the ID decides which prose speaks, and never whether a claim or a severity counts.
- **Standing is computed from the rounds.** A round of a revision stands when no round that counts names it as replaced. Nothing else says which round is current, so there is no pointer for a writer to roll back. Where a key is pinned, only a round that key signed counts, so only the trusted host's round can replace the trusted host's.
- **The gate takes the worst standing round.** Two rounds that stand together, because two hosts reviewed at once, gate by the worse, and not reviewed is worse than blocking.
- **A round's ID is its record's ID.** [The rounds decision](2026-10-18-compare-rounds-exact-rule.md) minted `<changeset>.r<n>` from a counter in each storage, and two hosts would each mint `r1`. Across hosts a round is named by its record's ID; `r<n>` stays a host's own label for display and for `--round` on that host. A comparison and a run snapshot name the round by its record ID. "Current" becomes "standing", and several may stand. A round's own records are frozen, as before. A dismissal is no part of a round: it applies to every standing round's verdict, which replaces "a dismissal reaches only the current round". Nothing orders rounds by mint: the coverage ledger's intake read "the last decided round", and it now reads every record of the revision, as rule 9 computes coverage.
- **`supersedes` is narrow.** Only a dismissal, a post, a status, the ledger comment and a comparison may carry it, and it names only records of its own changeset, kind and key. Supersession is a fact about the set, never about the order records arrived in, which the store does not keep: an entry applies whenever its target is in the set, and has no effect while it is not. A writer can therefore name a record before it lands only by building that exact record first, which the same writer could as well add and then supersede. An ID is a hash of a record's content, its `supersedes` included, so no two records can name each other. Supersession is permanent: a superseded record's own `supersedes` still applies. No record a review writes carries one.
- **Publication's own slots may tie.** A post, status or ledger comment record carries the generation of the lease it was made under, and the one of the highest generation stands in its slot. Two of one generation are settled by the lowest ID. That tie decides which comment Melian keeps, never a verdict.

### 5. A result's key is the request that produced it

Two rounds each found a key that left out an input: first a lens key without its route, then a verification key without the dismissed findings its verifier was shown. Each key was a list of inputs written by hand, and a list can miss one. So no list is written.

A check, a lens run, a verification and a walkthrough are results, and each has one request: the value Melian builds and hands to the producer. The result's key is the SHA-256 of that value's canonical bytes. The function that builds the request returns the key with it, so the producer cannot be given something the key does not cover.

For a lens run, a verification and a walkthrough, the request holds:

- the changeset's base and head, and the change as the prompt renders it;
- the instructions as rendered, with the standards, decisions and design sections read at base that they quote;
- the tools offered with their limits, the budget, the report schema, and the severities and rules the producer may use;
- the route in order, fallbacks included, and the thinking level;
- the producer's name and version, and for a lens the version of the algorithm that works out its delivery evidence, so a host with another algorithm builds another key and runs the lens itself;
- for a lens, its level, its band, the severity that escalates it, and the run it escalates to;
- for a verification, every claim in full with its severity, the fence, and each dismissed finding shown, with the ID of its dismissal record.

A check's request is built the same way, by one function that returns the key: its name, the changeset's base and head, its policy hash, the version of Melian's own implementation of the check, its tool's version where it has a tool, read from the tool's version command before the run, the host facts a tool's answer can turn on, which are the platform, the architecture, the runtime's version and whether the filesystem folds case, and every input the check's own decision makes part of its evidence's identity. Records now cross hosts, so a Linux runner's clean `static.tsc` must not answer for a macOS checkout that resolves a path's case differently. For mutation evidence those are the executor, installation, adapter and test identity [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md) names. A check with no tool, such as the guardrails, is keyed by Melian's version of it, so a host with a fixed check never imports the old one's result.

Four things stay out, and this list is the only place an exclusion is written:

- The rendered language line, which [the finding register](2026-10-24-finding-register.md) keeps out of a lens run's identity and the verifier's version. A changed `language` reruns nothing.

- **The boundary nonce.** It is random on every run and marks untrusted text. The key is taken over the request rendered with a fixed nonce, as the lens's instruction fingerprint is today.
- **Best-effort context.** A lens's callers listing and enclosing functions are left out of the instruction fingerprint today, because a host whose graph tool failed would otherwise rerun every lens. They stay out. Two hosts can so give one lens different context under one key.
- **Who chose and who paid.** The file or flag that set a route, and the credential, stay out, by [the run identity decision](2026-11-08-lens-run-identity.md).

What happened in the run is the payload, never the key: the model it finished on, its attempt, its spend, its time, and its answer. A lens run's payload also holds its delivery evidence, the lines the lens received in its prompt and through `read_file` and `search`, with the delivery algorithm's version. [The coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md) computes that from the transcript, and the transcript stays local, so the host that ran the lens computes it before it adds the record. A reader whose delivery algorithm differs recomputes it where its own store holds the transcript, and otherwise takes the coverage as void, as that decision rules. A lens record with no delivery evidence covers no line. A run that finished on a fallback is reused under the same route, as a local rerun reuses it under that decision, and the lineage names the model that finished.

A test holds the rule for each producer: it changes each field of the request in turn, the excluded four aside, and the key must change.

The other kinds are not results, and keep a named key:

- A dismissal's key is the finding's ID, and it carries no revision. Its payload holds the dismisser, the reason, the time, the severity the verdict showed, the frozen sighting with its region, the head it was made at, the rounds its writer listed, and the accepted trigger and proof that `dismissFinding` works out. A dismissal missing any of them is refused.
- A marker's key is the post it is for, the ledger or a revision's review at its round, and its hash.

### 6. The store's write access is the trust

A record counts because it is in the store, and the store decides who may write. Melian asks nothing more of a writer, and no writer holds a key. This is the trust [writers are trusted](../design.md#writers-are-trusted) already gives a commit status.

Melian cannot see a store's writers. `melian doctor` names the store and says its writers are trusted as the repository's. Two conditions make that true, and a deployment keeps both:

- The store's writers are the repository's writers. A branch of the repository has this by construction, and only that adapter takes `trust.writers` at its default. Melian treats any other store, such as a bucket, as `trust.writers: false` unless the base's root `melian.yaml` writes `trust.writers: true` out, so a setting left out never trusts a store whose writers Melian cannot see.
- Code under review never reaches the store. In CI, the job that runs a head's code hands its records to a job that runs none. That job adds only the kinds a review writes, only under that run's changeset and revision, and none with a `supersedes`. A dismissal, marker, post, status, ledger comment or comparison reaches the store only from a job that ran no head code. A head that tampers with its runner can still alter its own run's records, as it can alter its own verdict today. It cannot dismiss, and it cannot reach another round. That is a writer's head, whose writer is trusted.
- A fork's head gets no such latitude, and the key is never lent to what its code produced. For a fork the host runs two jobs, as [the unconfined decision](2026-10-14-static-checks-run-unconfined.md) set out. The job that runs the fork's code holds no key and no login, and hands over only the results of the checks that run head code, its tests and mutation check. The job that holds the key runs no head code: it runs the lenses, the verifier and the walkthrough itself, from the commit and the base's policy, builds the round itself, and signs only what it produced. It records a handed-over check result as relayed, unsigned as the host's own, and such a result counts as a fork's CI results do: it can fail the round, and its clean answer is evidence a person weighs before merging, never coverage the host vouches for. A lens record, a verification, a walkthrough or a round that arrives from the head-code job is refused, whatever its shape.

The trusted host holds the one key, pinned as `trust.host.key` in the root `melian.yaml` and read from the base commit. Two kinds of repository pin it:

- One that sets `trust.writers: false`. The gate then counts only records that key signed. A record it did not sign is set aside before every other rule: it supersedes nothing and stands nowhere. A signature proves a record genuine and never that none is missing: a writer who can rewind the store can drop the host's later blocking round and leave its earlier passing one. So such a repository keeps its record where only the trusted host can write, a branch its provider protects for the host alone or a store of its own. The store's write access is the trust, and a repository that does not trust its writers does not let them write the store. Melian cannot see who may write a store, so this is a requirement on the repository: the decision states it, `melian doctor` says it whenever `trust.writers` is `false`, and the guide for that setting names it. The maintainer ruled so on 2026-11-13, in the coordinator's session, over a second tally kept by the host, which would be another place to hold state.
- One that takes pull requests from forks, whatever `trust.writers` says, because without the key the gate cannot tell the trusted host's record of a fork's head from a writer's. For a fork's head the gate counts only records that key signed, so a repository that has not pinned it passes no fork's pull request, and the gate names what to set up. The maintainer ruled so on 2026-11-13, in the coordinator's session, over the alternative of a writer's recorded vouch: the rule's promise is that a fork's head was reviewed where its code could not touch the result, and a vouch promises only that a writer read it.

  This changes one clause of the coverage ledger decision's "Fork heads" section, which said no round of a fork's head records coverage, whoever runs it. A round the trusted host ran and signed now does. That section already named this end: in milestone 3 the agent refuses a record "whose head is not a writer's or the App's", and the trusted host is that App. The rest of the section stands. A writer's round of a fork's head records no coverage and reads not reviewed, with `--trust-head` or without it, because a writer's machine ran the fork's code where it could touch the result. A record of a fork's head with no signature, a bad one, or one from a key the base does not pin covers nothing. A repository with no pinned key passes no fork's pull request.

Every other repository has no key. The envelope keeps `signer` and `signature` so a later decision can add a named identity for each writer without a new format.

### 7. A dismissal counts only from a writer

- From the CLI, `melian dismiss` adds a dismissal record. Only a writer's own command adds one, since rule 6 keeps a head's job from adding the kind. The name on it is the git author, self-declared, as [the dismissal decision](2026-10-04-dismissal.md) rules.
- Through the provider, in milestone 4's comment commands, the trusted host reads the comment, asks the provider port for that login's permission, and for write or above adds a dismissal naming the login and the comment, signed with its key. That dismisser is verified.
- With `trust.writers: false`, only the second kind counts.
- A dismissal stands if its author was a writer when it was made.
- Any standing dismissal of a finding dismisses it, and each one's reason is shown.
- `melian dismiss` on a finding already dismissed adds a record that supersedes the dismissals it listed, so the new reason replaces the old and the superseded records are its history, as [the dismissal decision](2026-10-04-dismissal.md) rules. The same dismisser giving the same reason again adds nothing. Two dismissals stand together only when two writers dismissed at once.
- `dismiss` works offline, as it does today: it records locally, and the record reaches the store with the host's next add.
- A root, in [the restatement decision](2026-11-08-dismissal-carries-to-restatement.md)'s sense, is any standing dismissal a writer made, by the CLI or through the provider. Where several stand, the latest by its time is the one a restatement is judged against, as that decision's rule 8 has it.

A reopen is computed, not recorded, and from the set, never from an order. A dismissal record names the rounds its writer listed. A reader applies the lifecycle's reopen rule to every sighting of the finding in the set that those rounds do not hold, with that revision's proving hunks from git, since the lifecycle already reopens on different content "regardless of revision order". So a round that arrives late reopens what it would have reopened on time, whatever a later round named as the revision before it. A late round of a revision older than the dismissal can reopen it too; that fails closed, and a writer dismisses again. A dismissal once reopened stays reopened, though a later revision restores the old content. A reader that cannot read the hunks takes the dismissal as reopened.

### 8. Another host resumes by completing the manifest

A host imports the records it accepts into a fresh local store and runs only what lacks one. It builds each request its own run would make, and accepts a record whose key is that request's, by rule 5. So a host that sees a dismissal the first did not builds another verification request, and verifies again. It recomputes the line mapping and the voids from git, and never trusts a stored claim of coverage at a head it did not map, as [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md) rules. A record of a fork's head counts only from the trusted host, by rule 6.

### 9. The verdict, the coverage ledger, the ledger comment and the gate are computed

Each is a projection of the record and none is stored as the authority.

- The verdict comes from a round's records, the dismissals, the base commit's policy, and each revision's hunks from git.
- An inheritance is computed with it, never stored. A verification's payload holds the verifier's `same` or `different` for each claim against each dismissed finding it was shown, with that dismissal record's ID. The reader applies the other conditions of [the restatement decision](2026-11-08-dismissal-carries-to-restatement.md) itself, from the dismissal records and git, and an inheritance holds only while the dismissal the verifier was shown stands. The maintainer ruled so on 2026-11-13, in the coordinator's session: a head's job relays the judgement alone, so a forged record cannot claim that a trust-floor finding inherits or that a changed region is unchanged.
- The coverage ledger comes from which records cover which lines. It is no second store, so nothing carries it anywhere.
- The ledger comment renders the record, as it renders the local store today.
- The gate is a command, `melian gate "#N"`. It lists the record, computes the verdict of each standing round for the pull request's base and head, and exits with the worst. Any provider's CI can run it. The merge-group check runs it and writes the group's status; a status on the head is a display, and no gate reads one. Just before it writes that status, or copies an override, the check lists again, and computes again when the set differs from the one it read, as [the coordination decision](2026-11-08-how-melian-coordinates.md) requires of any job that writes from an authority it read earlier.
- An unresolved acknowledge finding fails the gate, as a blocking finding does and as [the acknowledge status rule](2026-10-17-acknowledge-status-exact-rule.md) has it for a host's publication. A writer resolves one by recording the read as a dismissal with its reason, from any host, since a dismissal now reaches the record. [The Actions round's status](2026-11-07-actions-round-sets-melian-review.md) exempted an Actions round because a runner could not dismiss; that reason is gone, and so is the exemption once the gate is the required check. The maintainer ruled so on 2026-11-13, in the coordinator's session. Until then the Actions status keeps its own rule, as a display.
- A round counts for a merge group when its head is the entry's and its reviewed base is an ancestor of the group's base, the test [melian/review on merge groups](2026-10-22-melian-review-on-merge-groups.md) already applies to a head's status. So a round stays good as `main` moves, and a retargeted pull request needs a new one.
- An Actions round writes records. Its job that runs head code hands its records to the job that runs none, by rule 6, and that job adds them. It still sets `melian/review` on the head, as a display and for a repository that has not yet moved its required check to the gate. This is what lets a builder's round count with no host: the queue reads the store, and the round is in it.

The gate fails closed with no standing round for the revision, a record not found, a base whose policy it cannot read, or a store it cannot reach. So no status needs fencing: a stale status decides nothing.

One status is still read. [The outage procedure](2026-10-23-melian-review-outage-procedure.md) lets the maintainer post an override on one commit when Melian cannot run, and a store that cannot be reached is such an outage. The merge-group check recognises that override on the head by the procedure's own form, unless a standing round of the revision holds a blocking finding, whatever that round's label. A round that reads not reviewed and found nothing blocking does not outrank it: a provider's usage limit can fail every lens and still leave a stored round, and that is the outage the override exists for. The maintainer ruled so on 2026-11-13, in the coordinator's session, and asked that a repository be able to set a stricter policy in its `melian.yaml`, which [issue #391](https://github.com/melian-agent/melian/issues/391) tracks. This replaces the coordination decision's order by time, where a round posted after the override outranked it: the record keeps no order, and a round with a blocking finding outranks an override whenever both are there, though a failed lens left the round's own label at not reviewed. When the check cannot reach the store it cannot know whether a round blocks, so it fails, and copies no override from the head: the maintainer posts the override on the entry's group commit, as the procedure already has them do when the workflow cannot run. That is a fresh act for that entry, so an old override never returns because the store dropped out.

### 10. A marker is proved by a value recorded before the post

Before it posts, the publisher adds a marker record holding the hash of a fresh random value and the login that will post, and puts the value in the comment's marker. A marker counts when the changeset's records hold its hash under the key of that post. Marker records are a set: an unused one from a crash before the post stays and harms nothing.

After the post, a `post` record names the comment's ID, and for a review the ID of each inline comment with the finding it speaks for, so any host can edit a comment and resolve its thread. Every reply Melian posts and every thread it resolves is a `post` record too, keyed by its finding and root comment. That is the reply journal and the list of owed resolutions [owed thread returns](2026-10-18-owed-thread-returns.md) kept in one host's storage, so a second host does not repeat a reply whose record stands, and retires what is owed across heads. A comment whose author the provider cannot report is never edited as the recorded ledger, as [the restored ledger clauses](2026-11-08-restore-ledger-clauses.md) require. The ID is the authority from then on, so the marker only covers a crash between the two. In that window the author is the whole defence, since a posted value is public: a resumed publisher takes a comment as its own only when it carries a recorded value and the provider reports its author as the login the marker record names. Recovery reads the login from the record and the author from the provider, never from the token, so it does not depend on the token knowing who it is, as [marker trust](2026-10-03-marker-trust.md) requires. Only a token's first post, made before any response has told it its login, records a marker without one; a crash in that one window posts afresh, and can leave an orphan to delete by hand, as today.

Nothing in the store is secret, and nothing in it needs sealing. A pull request's author cannot write the store, so cannot record a hash.

### 11. Only publication takes a lease

Publication is the one write that cannot be repeated safely. `melian publish` takes a short lease in the changeset's cell by compare-and-set, posts, records, and releases it. Core's `Lease` keeps its incarnation and generation for this. Storage takes no lease.

Publication binds the round the gate would take. [The publication triage guard](2026-10-19-publication-triage-guard.md) made a publisher, fresh or resumed, refuse unless its bound round was the revision's current round, and this design has no current round: several can stand. So a publisher binds the worst standing round of the revision, by rule 4, which is the verdict `melian gate` exits with. Where several standing rounds share the worst outcome, it binds the one with the lowest ID; that tie picks which findings are posted and never the outcome. Holding the lease, it lists again just before each provider effect, and when the worst standing round is no longer the one it bound, or the standing dismissals its verdict was computed with have changed, it ends superseded, posts nothing more, and names the round to publish. A dismissal is no part of a round and still changes its verdict, so the binding is the round and those dismissals together. A passing round is therefore never published after a blocking round of the same revision has landed. The guard's other check, an adjudication for the revision, becomes a standing round for it; with none, the publisher ends superseded as before.

A provider takes no fence, so a holder paused past its lease can still post after its successor. A time margin narrows that and cannot close it, so the stale publisher removes its own effect: after each post it reads the cell again, and when the lease is no longer its own it deletes what it posted and records nothing. A publisher posts only while its lease has more than one post's deadline left, which keeps that rare. One that dies between its post and that read leaves a post with a recorded marker and no `post` record, and the next publish deletes it. One that passes that read, pauses, and records its post after a successor took the lease adds a record of an older generation, which rule 4 never lets stand. Until then a stale review can show on the pull request. It gates nothing, since the gate reads no post.

The login on the standing `post` record owns a pull request's reviews and its ledger comment. A publish that knows its login to be another refuses, naming the owner. Whether a token may edit is the provider's answer, not a guess from its login. A cloud session cannot set a status, so publication runs on the trusted host or from a maintainer's CLI.

### 12. The git adapter

It keeps what the superseded decision got right:

- The branch is `melian/state` on the repository's own remote. A cloud session's proxy refuses other refs.
- Melian builds each commit with git's plumbing, in the clone's object database, and never checks the branch out.
- Every push names the tip it fetched with `--force-with-lease`. A lost race fetches again and retries until the deadline, waiting a random time below a bound that grows past one push's time.
- A fetch or push stops at a two-minute wall-clock deadline. A push stopped there counts as landed when the commit it sent is the tip or an ancestor of it.
- When the branch cannot be reached, a review works locally and adds its records later. `melian publish` and the gate refuse without the store.

What changes: one commit holds a whole batch, since one push took 3.3 seconds in [issue #370](https://github.com/melian-agent/melian/issues/370); and the lease, the sealing, the copy locks, the clone ID and the set-aside copies go.

A record is a plain JSON file at `changesets/<changeset>/<kind>/<hash of key>/<id>.json`, and the cell is `changesets/<changeset>/cell.json`. A file is known when its path is the one its own bytes give. A branch holding any other file is refused whole, before a byte is read in part or pushed over, and the refusal and `melian doctor` name the file for a writer to remove.

### 13. Retention

Once a changeset's records are in the store, everything local is cache, and [issue #348](https://github.com/melian-agent/melian/issues/348) may prune it. The live record is small enough to keep, so closing a pull request disposes nothing: a pull request can be reopened, and its records must still take a review. `dispose` removes a changeset's records for good, and only a writer's own command calls it.

A store's own history is its adapter's to bound, and the git adapter does not bound it yet. Each batch is a commit, and a disposed changeset stays in the branch's history, so a fresh runner's fetch grows with every review until it passes the deadline. Plain files delta where sealed ones could not, which slows that and does not stop it. [Issue #361](https://github.com/melian-agent/melian/issues/361) stays open to design the bound, a fetch of the tip alone or a compaction that is safe beside concurrent pushes, and the git adapter's build is not done without it.

## What the reviews found

Three reviews tested the first draft with unit tests, before any ruling: [issue #378](https://github.com/melian-agent/melian/issues/378) on the envelope, replacement and keys, [issue #379](https://github.com/melian-agent/melian/issues/379) on the import and the gate, and [issue #380](https://github.com/melian-agent/melian/issues/380) on trust, markers and publication. Melian's own round on [pull request #377](https://github.com/melian-agent/melian/pull/377) added finding `3045335b9e5de9a9`. Together they raised seven P1s, and the text above answers each. A second round, on the revised text, raised two more, `c97f874268bb2af2` and `fa6fdfb18b069a75`, and three P2s; they are the table's next rows. A third round raised one P1 and four P2s, the next five rows, and a fourth raised one P1 and one P2, the last two:

| Finding | Answer |
| --- | --- |
| Any record could supersede a blocking sighting, a dismissal or a round | Rule 4 limits `supersedes` to five kinds and to one slot; a review's records carry none |
| The lowest-ID rule and "the worse verdict" contradicted each other for rounds, and a ground ID could pass the gate | Rule 4: nothing a verdict reads is chosen by a hash |
| Naming a predecessor round had no stated effect | Rule 4: a round replaces the rounds of its revision it names |
| A stale list passed the gate on an older round | Rule 3: `list` is fresh, or the call fails |
| The computed verdict lacked each revision's hunks, so a dismissal never reopened | Rules 7 and 9 |
| The fork rule could not be applied without a key | Rule 6: a repository that takes fork pull requests pins the trusted host's key |
| A head job's dismissal passed the relay's shape check | Rule 6: the relay adds only a review's kinds |
| With a key pinned, a writer could roll the cell back to an older signed round | Rule 4: no pointer names the standing rounds; they are computed, and only a signed round replaces a signed one |
| A publisher holding a fresh lease could read a stale list and post twice | Rule 3: `list` is fresh |
| The gate read no status, so the outage override stopped working | Rule 9 keeps the override, when the store holds no round, and on the group commit when the store is missing |
| Recovery of a post depended on the token knowing its login | Rule 10 reads the login from the marker record and the author from the provider |
| The record's size was measured, the branch's history was not | Rule 13 keeps [issue #361](https://github.com/melian-agent/melian/issues/361) open |
| A verification's key left out the dismissed findings its verifier was shown (`84393ef8353d494c`) | Rule 5: a result's key is its whole request |
| A lens key named the route, not the model that finished (`7fdc214d65fcdd00`) | Rule 5 keeps the route as the key, as the run identity decision rules for a local rerun; the payload names the model |
| A store that is no branch was trusted when the setting was left out (`9f15b868be294320`) | Rule 6: only the branch adapter takes the default |
| An old override counted again when the store dropped out (`112d07cbd2e76a97`) | Rule 9: an unreachable store copies no override from the head |
| A publisher paused after its lease check posted a stale review (`6f40c2c204f44f8e`) | Rule 11: a publisher that lost its lease deletes its own post |
| Coverage is proved from transcripts, which no longer leave the host (`e89038cecd83e25c`) | Rule 5: a lens record carries its delivery evidence, and one without it covers no line |
| A closed pull request was disposed, so a reopened one could record nothing (`d48f504f94e100d3`) | Rule 13: closing disposes nothing |
| A signed record let a fork's head count, against the coverage ledger's "Fork heads" section, which this file did not amend (`ab55c8493996ace2`) | Rule 6 and the header: the section is amended for a record the trusted host signed, and every other clause of it stands |
| Whether a `supersedes` entry applied depended on arrival order, which the store does not keep (`2839409b73dade40`) | Rule 4: an entry applies whenever its target is in the set |
| A round's frozen list of earlier rounds skipped one that arrived late and reopened a dismissal (`19de850807b1107d`) | Rule 7: a reopen is computed from every sighting in the set, in no order |
| A check's key left out Melian's own version of the check and the mutation executor (`00638ec931f0ec40`) | Rule 5: a check's request is built whole, as the others are |
| The merge-group check wrote its status from a list it read earlier (`c88b6f3b39196e7a`) | Rule 9: it lists again just before it writes |
| Two runs of one lens tied in the merge, so list order chose the speaker (`51cdb2a1409fc35e`) | Rule 4: the record's ID breaks the tie, and no claim or severity is dropped |
| A publisher that lost its lease after its check still recorded its post, and could win the slot (`f4c883cd4496d7a2`) | Rules 4 and 11: the highest lease generation stands |
| With several rounds standing, nothing said which one a publisher binds, so a stale passing round could be posted (`d4be369f97b0b5ac`) | Rule 11: a publisher binds the worst standing round and checks it again before each post |
| "Worst" picked no round when two shared an outcome (`bb80a02d68de0481`) | Rule 11: the lowest ID among them, which never decides the outcome |
| The rounds decision's current round, mint order and `r<n>` IDs were replaced with no declared edge (`ee6788044456c49d`, and the sweep) | The header amends it and its dependants; rule 4 says what a round's ID, "current" and "frozen" become |
| An Actions round's status stopped gating, and nothing said its records reach the store (sweep) | Rule 9: an Actions round writes records |
| The gate gave every round the Actions status's exemption for an unresolved acknowledgement (`066ca028c0ed560a`) | Rule 9: an unresolved acknowledgement fails the gate, by the maintainer's ruling; a writer records the read as a dismissal |
| The gate did not say which base a round must match in a merge group (sweep) | Rule 9 keeps the ancestor test |
| A later dismissal did not replace an earlier one, and `dismiss` had no offline rule (sweep) | Rule 7 |
| An inheritance's root and the head a dismissal was made at were unstated (sweep) | Rules 5 and 7 |
| The language line would have entered every key (sweep) | Rule 5: a fourth exclusion |
| The reply journal and owed resolutions stayed on one host (sweep) | Rule 10: each reply and resolution is a `post` record |
| ID-first merge order let a lower severity speak (sweep) | Rule 4 keeps severity first |
| The override was refused when a round stood that read not reviewed, the very outage it is for (`807a4d728b569993`, and the sweep) | Rule 9: only a standing round that blocks outranks it, by the maintainer's ruling |
| A round that read not reviewed and also held a block did not outrank the override (`7254f59a03ce32ef`) | Rule 9: a blocking finding outranks it, whatever the round's label |
| A check's key left out the host facts its tool's answer turns on (`b5c201e39ccbd168`) | Rule 5: platform, architecture, runtime and case folding are in a check's request |
| With `trust.writers: false`, a writer could rewind the branch and drop the host's blocking round (`26e8879cab5aecc6`) | Rule 6: such a repository keeps its record where only the trusted host can write, by the maintainer's ruling |
| A fork's head-code job could hand over a made-up round for the host to sign (`f4eabb100a734a58`) | Rule 6: for a fork, the keyed job runs the lenses and builds the round itself, and signs only what it produced |
| A lens record made under another delivery algorithm matched the key (`bcefebbb64f3af28`) | Rule 5: the algorithm's version is in a lens's request |
| A publisher bound the round and not the dismissals that change its verdict (`509acf84a1c94caf`) | Rule 11: it binds both, and checks both before each post |

## What this gives up

- A runner killed in the middle of a lens reruns that lens. Only finished tasks cross hosts.
- Findings sit in plain text in the store before publication, readable by anyone who can read the repository.
- A dismisser from the CLI stays self-declared. A repository that must prove who dismissed uses the provider path.
- A writer can run a round that replaces a blocking one, as a writer can rerun a review or set a status today. [Issue #379](https://github.com/melian-agent/melian/issues/379) proposed counting only rounds the trusted host signed; that puts a key in every repository, which the maintainer's direction on logistics rules out. The maintainer agreed on 2026-11-13, in the coordinator's session.
- A writer can block by adding a second round, since the worse gates.
- A comment command on another host works from the record, so an explanation cannot draw on the lens's transcript, and a steer reaches a running review only on its own host.
- A stale review can show on a pull request until the next publish, when a publisher dies between its post and its lease check.
- Two hosts can give one lens different callers and enclosing functions under one key.
- One file the adapter does not know stops every gate and publish on the branch until a writer removes it.
- A repository that takes fork pull requests holds one key, in CI alone.
- A repository with `trust.writers: false` must protect its store from its own writers, and Melian cannot check that it has.
- The record is a new stored shape, with versions to migrate and an import path to keep true, about 400 to 550 lines by [issue #372](https://github.com/melian-agent/melian/issues/372)'s estimate.
- The reopen rule, sighting merge and verifier lowering live in the pipeline, so a gate that is core alone needs them moved.
- A pull request whose markers were made under the per-changeset secret finishes on its local store.

## Work in flight

- `packages/state-git` on `main`, from [pull request #310](https://github.com/melian-agent/melian/pull/310), holds the superseded form until the git adapter replaces it.
- [Pull request #314](https://github.com/melian-agent/melian/pull/314) is frozen at `92faa656` by the maintainer's ruling of 2026-11-13, and does not land if this is adopted.
- This closes the need for [issue #317](https://github.com/melian-agent/melian/issues/317), [issue #307](https://github.com/melian-agent/melian/issues/307), [issue #319](https://github.com/melian-agent/melian/issues/319) and [issue #340](https://github.com/melian-agent/melian/issues/340), and settles [issue #154](https://github.com/melian-agent/melian/issues/154) by rule 11.
- The coverage drafts, [pull request #216](https://github.com/melian-agent/melian/pull/216), [pull request #218](https://github.com/melian-agent/melian/pull/218) and [pull request #220](https://github.com/melian-agent/melian/pull/220), are replanned as a projection of the record.

## Still open

- No review ran the gate on a merge-group runner, so what it lacks there is untested.
- The reviews tested scripts that word these rules, not product code. Each build's tests must fail with its rule removed.
