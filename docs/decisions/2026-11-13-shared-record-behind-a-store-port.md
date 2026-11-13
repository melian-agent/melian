# Hosts share a record of facts behind a store port, and working state stays where it ran

Supersedes: [the state branch decision](2026-11-07-state-branch-storage.md)
Amends: [the coordination decision](2026-11-08-how-melian-coordinates.md), rule 2's lease on the state branch and rule 3's fence on `melian/review`
Amends: [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md), its "Sharing, for milestone 3" section
Amends: [melian/review on merge groups](2026-10-22-melian-review-on-merge-groups.md), what the merge-group check reads
Amends: [marker trust](2026-10-03-marker-trust.md), what proves a marker
Amends: [dismissal](2026-10-04-dismissal.md), where a dismissal lives and who may write one
Amends: [Actions complete the manifest](2026-10-04-actions-complete-the-manifest.md), the form a local record takes

Status: proposed on 2026-11-13, for the maintainer's ruling. Not built. The maintainer asked for it in the coordinator's session that day, after a review of the design's gaps in durable state, and gave four directions there: nothing may rely on one provider's features; the contract must not assume git; distributing keys must need no logistics; and a dismissal counts only from a writer. Six spikes tested the first draft, under [issue #368](https://github.com/melian-agent/melian/issues/368). Three reviews then tested that draft with unit tests, as [the convergence rules](2026-10-15-review-loop-convergence-rules.md) require of a ruling on trust, and this text answers what they found.

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

### 2. Hosts share the record

The record is a set of immutable facts, one per record. A review writes six kinds: a check's result, a lens run's sightings, a verification, an inheritance, a walkthrough and a round, with optional telemetry. Five kinds come from a command, never from a review: a dismissal, a marker, a post, a status and the ledger comment, with a comparison beside them. [Issue #369](https://github.com/melian-agent/melian/issues/369)'s table sorts every document Melian stores into a kind or into working state.

A host adds a review's records in batches as its tasks finish, one batch at a time, and the round's closing record last. So a runner that dies has already shared every lens and check it finished, and its successor reruns only the task that was cut.

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
- `list` may be stale.
- `readCell` is fresh: it returns the last value a `writeCell` stored.
- `writeCell` succeeds only when the cell's version is still `expectedVersion`. A version is opaque and changes on every successful write, never a hash of the value, and a writer that dies leaves nothing that blocks the next. The conformance suite holds the case of a value that went away and came back.
- `dispose` first writes a disposal mark to the cell, and `add` refuses a changeset whose cell holds one.
- It promises no ordering of records, no history, no transaction across records, no secrecy, and no identity for a writer.

The cell holds one small JSON value: the standing rounds of each revision, the publication lease, and the disposal mark.

### 4. Nothing a verdict reads is chosen by a hash

The first draft settled two records in one slot by the lowest ID. [Issue #378](https://github.com/melian-agent/melian/issues/378) showed a writer could grind an ID to win a slot, and Melian's own design lens showed two honest hosts losing a blocking sighting that way, since two runs of one lens can differ. So:

- **A round names what it rests on.** Its closing record lists the kind, key and ID of every record it read, its walkthrough or that it has none, the earlier rounds of its revision it replaces, and the rounds of the revision before. A record a round names counts for that round. One that does not match the named kind, key and ID together counts as not found, and a round with a record not found reads as not reviewed.
- **An import keeps every record.** A host that finds several trusted records under the key its own run would use imports all of them, and their sightings merge as two lenses' sightings do. Nothing is dropped.
- **The cell names the standing rounds.** Closing a round writes its ID to the cell by compare-and-set, in place of the rounds it replaces. A writer that loses the race reads again and adds its round beside the other's.
- **The gate takes the worst standing round.** It reads the cell, and fails closed when `list` lacks a round the cell names, so a stale list never passes on an older round. Two rounds that stand together, because two hosts reviewed at once, gate by the worse, and not reviewed is worse than blocking.
- **`supersedes` is narrow.** Only a dismissal, a post, a status, the ledger comment and a comparison may carry it, and it names only records of its own changeset, kind and key. An entry naming no record has no effect, then or later. Supersession is permanent: a superseded record's own `supersedes` still applies. No record a review writes carries one.
- **Publication's own slots may tie.** Two posts, statuses or ledger comments that stand in one slot are settled by the lowest ID. That tie decides which comment Melian keeps, never a verdict.

### 5. Keys say what ran

- A lens run's key is its whole selection line from the review index: name, version and level, thinking, instruction hash, band, escalation and route, each field present with an explicit none. A run is the model and level that ran, by the maintainer's ruling of 2026-11-08 on [issue #243](https://github.com/melian-agent/melian/issues/243#issuecomment-6720816030). Its payload carries the model it finished on, its attempt and its spend.
- A verification's key is the verifier's version, the IDs of the lens records whose sightings it judged, and its candidate's claim IDs, each list sorted and distinct. A finding's ID does not cover its severity, so the lens records are named.
- A check's key is its name and policy hash, and its payload carries the tool's version. An import reads its own tool's version from the tool's version command, and takes no check record that lacks one or differs.
- A dismissal's key is the finding's ID, and it carries no revision. Its payload holds the dismisser, the reason, the time, the severity the verdict showed, the frozen sighting, and the accepted trigger and proof that `dismissFinding` works out. A dismissal missing any of them is refused.
- A marker's key is the post it is for, the ledger or a revision's review at its round, and its hash.

### 6. The store's write access is the trust

A record counts because it is in the store, and the store decides who may write. Melian asks nothing more of a writer, and no writer holds a key. This is the trust [writers are trusted](../design.md#writers-are-trusted) already gives a commit status.

Melian cannot see a store's writers. `melian doctor` names the store and says its writers are trusted as the repository's. Two conditions make that true, and a deployment keeps both:

- The store's writers are the repository's writers. A branch of the repository has this by construction. A store elsewhere, such as a bucket, sets `trust.writers: false`.
- Code under review never reaches the store. In CI, the job that runs a head's code hands its records to a job that runs none. That job adds only the kinds a review writes, only under that run's changeset and revision, and none with a `supersedes`. A dismissal, marker, post, status, ledger comment or comparison reaches the store only from a job that ran no head code. A head that tampers with its runner can still alter its own run's records, as it can alter its own verdict today. It cannot dismiss, and it cannot reach another round.

An inheritance stays on the relayed list. It is the verifier's judgement, made in the review, and a forged one does what a forged lens record that omits the finding does.

The trusted host holds the one key, pinned as `trust.host.key` in the root `melian.yaml` and read from the base commit. Two kinds of repository pin it:

- One that sets `trust.writers: false`. The gate then counts only records that key signed. A record it did not sign is set aside before every other rule: it supersedes nothing and stands nowhere.
- One that takes pull requests from forks, whatever `trust.writers` says, because without the key the gate cannot tell the trusted host's record of a fork's head from a writer's. This clause awaits the maintainer's ruling.

Every other repository has no key. The envelope keeps `signer` and `signature` so a later decision can add a named identity for each writer without a new format.

### 7. A dismissal counts only from a writer

- From the CLI, `melian dismiss` adds a dismissal record. Only a writer's own command adds one, since rule 6 keeps a head's job from adding the kind. The name on it is the git author, self-declared, as [the dismissal decision](2026-10-04-dismissal.md) rules.
- Through the provider, in milestone 4's comment commands, the trusted host reads the comment, asks the provider port for that login's permission, and for write or above adds a dismissal naming the login and the comment, signed with its key. That dismisser is verified.
- With `trust.writers: false`, only the second kind counts.
- A dismissal stands if its author was a writer when it was made.
- Any standing dismissal of a finding dismisses it, and each one's reason is shown.

A reopen is computed, not recorded. A reader walks the revisions from the dismissal's to the one it judges, in the order the rounds name, and applies the lifecycle's reopen rule at each with that revision's proving hunks from git. A dismissal once reopened stays reopened, though a later revision restores the old content. A reader that cannot read the hunks takes the dismissal as reopened.

### 8. Another host resumes by completing the manifest

A host imports the records it accepts into a fresh local store and runs only what lacks one. It accepts a record whose key equals the one its own run would use, and whose policy fingerprint it recomputes from the base commit. It recomputes the line mapping and the voids from git, and never trusts a stored claim of coverage at a head it did not map, as [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md) rules. A record of a fork's head counts only from the trusted host, by rule 6.

### 9. The verdict, the coverage ledger, the ledger comment and the gate are computed

Each is a projection of the record and none is stored as the authority.

- The verdict comes from a round's records, the dismissals, the base commit's policy, and each revision's hunks from git.
- The coverage ledger comes from which records cover which lines. It is no second store, so nothing carries it anywhere.
- The ledger comment renders the record, as it renders the local store today.
- The gate is a command, `melian gate "#N"`. It reads the cell and the record, computes the verdict of each standing round for the pull request's base and head, and exits with the worst. Any provider's CI can run it. The merge-group check runs it and writes the group's status; a status on the head is a display, and no gate reads one.

The gate fails closed with no standing round for the revision, a round the list lacks, a record not found, a base whose policy it cannot read, or a store it cannot reach. So no status needs fencing: a stale status decides nothing.

### 10. A marker is proved by a value recorded before the post

Before it posts, the publisher adds a marker record holding the hash of a fresh random value and the login that will post, and puts the value in the comment's marker. A marker counts when the changeset's records hold its hash under the key of that post. Marker records are a set: an unused one from a crash before the post stays and harms nothing.

After the post, a `post` record names the comment's ID, and the ID is the authority from then on, so the marker only covers a crash between the two. In that window the author is the whole defence, since a posted value is public: a resumed publisher takes a comment as its own only when it carries a recorded value and its author is the login the marker record names. A publisher that knows no login takes no comment as its own and posts afresh. That can leave an orphan to delete by hand, as today.

Nothing in the store is secret, and nothing in it needs sealing. A pull request's author cannot write the store, so cannot record a hash.

### 11. Only publication takes a lease

Publication is the one write that cannot be repeated safely. `melian publish` takes a short lease in the changeset's cell by compare-and-set, posts, records, and releases it. Core's `Lease` keeps its incarnation and generation for this. Storage takes no lease.

A provider takes no fence, so a holder paused past its lease can still post after its successor. Two rules narrow that and repair it: a publisher posts only while its lease has more than one post's deadline left, and the next publish deletes a post whose `post` record lost its slot.

The login on the standing `post` record owns a pull request's reviews and its ledger comment. A publish under another login refuses, naming the owner, and a publisher that cannot read its own login refuses to edit. A cloud session cannot set a status, so publication runs on the trusted host or from a maintainer's CLI.

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

Once a changeset's records are in the store, everything local is cache, and [issue #348](https://github.com/melian-agent/melian/issues/348) may prune it. The record is small enough to keep. `dispose` removes a changeset's records; reclaiming a git branch's history is the adapter's own housekeeping.

## What the reviews found

Three reviews tested the first draft with unit tests, before any ruling: [issue #378](https://github.com/melian-agent/melian/issues/378) on the envelope, replacement and keys, [issue #379](https://github.com/melian-agent/melian/issues/379) on the import and the gate, and [issue #380](https://github.com/melian-agent/melian/issues/380) on trust, markers and publication. Melian's own round on [pull request #377](https://github.com/melian-agent/melian/pull/377) added finding `3045335b9e5de9a9`. Together they raised seven P1s, and the text above answers each:

| Finding | Answer |
| --- | --- |
| Any record could supersede a blocking sighting, a dismissal or a round | Rule 4 limits `supersedes` to five kinds and to one slot; a review's records carry none |
| The lowest-ID rule and "the worse verdict" contradicted each other for rounds, and a ground ID could pass the gate | Rule 4: nothing a verdict reads is chosen by a hash |
| Naming a predecessor round had no stated effect | Rule 4: a round replaces the rounds of its revision it names |
| A stale list passed the gate on an older round | Rules 3 and 4: the cell names the standing rounds, and reading it is fresh |
| The computed verdict lacked each revision's hunks, so a dismissal never reopened | Rules 7 and 9 |
| The fork rule could not be applied without a key | Rule 6, awaiting a ruling |
| A head job's dismissal passed the relay's shape check | Rule 6: the relay adds only a review's kinds |

## What this gives up

- A runner killed in the middle of a lens reruns that lens. Only finished tasks cross hosts.
- Findings sit in plain text in the store before publication, readable by anyone who can read the repository.
- A dismisser from the CLI stays self-declared. A repository that must prove who dismissed uses the provider path.
- A writer can run a round that replaces a blocking one, as a writer can rerun a review or set a status today. [Issue #379](https://github.com/melian-agent/melian/issues/379) proposed counting only rounds the trusted host signed; that puts a key in every repository, which the maintainer's direction on logistics rules out.
- A writer can block by adding a second round, since the worse gates.
- One file the adapter does not know stops every gate and publish on the branch until a writer removes it.
- A repository that takes fork pull requests holds one key, if rule 6's clause is ruled in.
- The record is a new stored shape, with versions to migrate and an import path to keep true, about 400 to 550 lines by [issue #372](https://github.com/melian-agent/melian/issues/372)'s estimate.
- The reopen rule, sighting merge and verifier lowering live in the pipeline, so a gate that is core alone needs them moved.
- A pull request whose markers were made under the per-changeset secret finishes on its local store.

## Work in flight

- `packages/state-git` on `main`, from [pull request #310](https://github.com/melian-agent/melian/pull/310), holds the superseded form until the git adapter replaces it.
- [Pull request #314](https://github.com/melian-agent/melian/pull/314) is frozen at `92faa656` by the maintainer's ruling of 2026-11-13, and does not land if this is adopted.
- This closes the need for [issue #317](https://github.com/melian-agent/melian/issues/317), [issue #307](https://github.com/melian-agent/melian/issues/307), [issue #319](https://github.com/melian-agent/melian/issues/319), [issue #340](https://github.com/melian-agent/melian/issues/340) and [issue #361](https://github.com/melian-agent/melian/issues/361), and settles [issue #154](https://github.com/melian-agent/melian/issues/154) by rule 11.
- The coverage drafts, [pull request #216](https://github.com/melian-agent/melian/pull/216), [pull request #218](https://github.com/melian-agent/melian/pull/218) and [pull request #220](https://github.com/melian-agent/melian/pull/220), are replanned as a projection of the record.

## Still open

- Rule 6's clause on fork pull requests awaits the maintainer's ruling.
- No review ran the gate on a merge-group runner, so what it lacks there is untested.
- The reviews tested scripts that word these rules, not product code. Each build's tests must fail with its rule removed.
