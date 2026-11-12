# Hosts share a record of facts behind a store port, and working state stays where it ran

Supersedes: [the state branch decision](2026-11-07-state-branch-storage.md)
Amends: [the coordination decision](2026-11-08-how-melian-coordinates.md), rule 2's lease on the state branch and rule 3's fence on `melian/review`
Amends: [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md), its "Sharing, for milestone 3" section
Amends: [melian/review on merge groups](2026-10-22-melian-review-on-merge-groups.md), what the merge-group check reads
Amends: [marker trust](2026-10-03-marker-trust.md), what proves a marker
Amends: [dismissal](2026-10-04-dismissal.md), where a dismissal lives and who may write one
Amends: [Actions complete the manifest](2026-10-04-actions-complete-the-manifest.md), the form a local record takes

Status: proposed on 2026-11-13, for the maintainer's ruling. Not built. The maintainer asked for it in the coordinator's session that day, after a review of the design's gaps in durable state, and gave four directions there: nothing may rely on one provider's features; the contract must not assume git; distributing keys must need no logistics; and a dismissal counts only from a writer. Six spikes tested the first draft, under [issue #368](https://github.com/melian-agent/melian/issues/368). It must be attacked before a build starts, as [the convergence rules](2026-10-15-review-loop-convergence-rules.md) require of a ruling on trust.

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

The record is a set of immutable facts, one per record. Its kinds are a check's result, a lens run's sightings, a verification, a round, a dismissal, an inheritance, a walkthrough, a post, a status, the ledger comment, a comparison, and optional telemetry. [Issue #369](https://github.com/melian-agent/melian/issues/369)'s table sorts every document Melian stores into a kind or into working state.

A host adds a review's records in batches as its tasks finish, and the round's closing record last. So a runner that dies has already shared every lens and check it finished, and its successor reruns only the task that was cut.

### 3. The record store is a port

Core defines it, and git is its first adapter. A memory adapter serves tests and a directory adapter proves the contract leaks nothing of git. Every adapter runs one conformance suite, as Pi's storage adapters run Pi's.

```ts
type RecordEnvelope = {
  v: 1;
  changeset: string;
  revision?: string; // Revision.key, for a fact about one base and head
  kind: string;
  key: string;
  supersedes?: string[]; // IDs of the records this one replaces
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

- A record's ID is the SHA-256 of its envelope's canonical bytes: UTF-8 JSON, object keys sorted, no whitespace, text as given, integers within the safe range.
- An envelope holds these fields and no other. A signature is 64 bytes in canonical base64. Without both rules one signed fact takes any number of IDs, as [issue #371](https://github.com/melian-agent/melian/issues/371) showed.
- `changeset` and `kind` use lower-case letters, digits, dots and hyphens, since an adapter may make them path components. An adapter hashes `key`.
- `add` can be repeated: the same bytes twice are one record. A batch may land in part, and a repeat completes it.
- `list` may be stale.
- `writeCell` succeeds only when the cell's version is still `expectedVersion`. A version is opaque and changes on every successful write, never a hash of the value, which would let a stale writer through after the value went there and back.
- The contract promises no ordering, no history, no transaction across records, no secrecy, and no identity for a writer.

### 4. Replacement and order are in the records

- A record that replaces another names it in `supersedes`. A superseded record no longer counts. A second dismissal, a reopen, a lens rerun and each new value of the ledger comment or the status are replacements.
- Among records under one kind, key and revision that nothing supersedes, the lowest ID wins. Only two hosts that did the same work at once meet this rule.
- A round's closing record names the kind, key and ID of every record it rests on, and the rounds before it. A reader that cannot find one of them reads the round as not reviewed, so a stale `list` or a half-written batch fails closed.
- When two rounds of one revision both stand, because two hosts reviewed it at once, the gate takes the worse verdict.

### 5. Keys say what ran

- A lens run's key is its whole selection line from the review index: name, version and level, thinking, instruction hash, band, escalation and route. A run is the model and level that ran, by the maintainer's ruling of 2026-11-08 on [issue #243](https://github.com/melian-agent/melian/issues/243#issuecomment-6720816030). Its payload carries the model it finished on, its attempt and its spend.
- A verification's key is its candidate's claim IDs and the verifier's version, so verdicts and sightings from two hosts cannot be mixed into a candidate neither judged.
- A check's key is its name and policy hash. The tool's version is known only after it runs, so it sits in the payload, and an import compares it.
- A dismissal's payload holds what `dismissFinding` works out: the severity the verdict showed, the frozen sighting, and the accepted trigger and proof. A reader decides at each revision whether the dismissal still stands, by the lifecycle's reopen rule.

### 6. The store's write access is the trust

A record counts because it is in the store, and the store decides who may write. Melian asks nothing more of a writer, and no writer holds a key. This is the trust [writers are trusted](../design.md#writers-are-trusted) already gives a commit status.

Two conditions make it hold, and a deployment must keep both:

- The store's writers are the repository's writers. A branch of the repository has this by construction. A store elsewhere, such as a bucket, needs its access kept in step.
- Code under review never holds the store's credential. In CI, the job that runs a head's code hands its records to a job that runs none, which checks their shape and adds them. A head that tampers with its runner can still alter them, as it can alter the verdict today, and only a writer's head runs there.

The trusted host holds the one key. A repository that sets `trust.writers: false` pins its public half in the root `melian.yaml`, read from the base commit, and the gate then counts only records that key signed. Every other repository has no key at all. The envelope keeps `signer` and `signature` so a later decision can add a named identity for each writer without a new format.

### 7. A dismissal counts only from a writer

- From the CLI, `melian dismiss` adds a dismissal record. The store accepted the write, so a writer made it. The name on it is the git author, self-declared, as [the dismissal decision](2026-10-04-dismissal.md) rules.
- Through the provider, in milestone 4's comment commands, the trusted host reads the comment, asks the provider port for that login's permission, and for write or above adds a dismissal naming the login and the comment, signed with its key. That dismisser is verified.
- With `trust.writers: false`, only the second kind counts.
- A dismissal stands if its author was a writer when it was made.

### 8. Another host resumes by completing the manifest

A host imports the records it accepts into a fresh local store and runs only what lacks one. It accepts a record whose key equals the one its own run would use, and whose policy fingerprint it recomputes from the base commit. It recomputes the line mapping and the voids from git, and never trusts a stored claim of coverage at a head it did not map, as [the coverage ledger decision](2026-10-23-coverage-ledger-and-delta-review.md) rules. A record from a fork's head counts only from the trusted host.

### 9. The verdict, the coverage ledger, the ledger comment and the gate are computed

Each is a projection of the record and none is stored as the authority.

- The verdict comes from a round's records, the dismissals, the base commit's policy and the diff.
- The coverage ledger comes from which records cover which lines. It is no second store, so nothing carries it anywhere.
- The ledger comment renders the record, as it renders the local store today.
- The gate is a command, `melian gate "#N"`. It lists the record, computes the verdict for the pull request's base and head, and exits with it. Any provider's CI can run it. The merge-group check runs it and writes the group's status; a status on the head is a display, and no gate reads one. With no round for the revision, or a store it cannot reach, the gate fails closed.

So no status needs fencing: a stale status decides nothing.

### 10. A marker is proved by a value recorded before the post

Before it posts, the publisher adds a record holding the hash of a fresh random value, and puts the value in the comment's marker. A marker counts when the store holds its hash for that pull request. After the post, a `post` record names the comment's ID, and the ID is the authority from then on, so the marker only covers a crash between the two. The author stays a filter, never the proof, as [marker trust](2026-10-03-marker-trust.md) rules.

Nothing in the store is secret, and nothing in it needs sealing. A pull request's author cannot write the store, so cannot record a hash.

### 11. Only publication takes a lease

Publication is the one write that cannot be repeated safely. `melian publish` takes a short lease in the changeset's cell by compare-and-set, posts, records, and releases it. Core's `Lease` keeps its incarnation and generation for this. Storage takes no lease.

The first publisher's login owns a pull request's reviews and its ledger comment. The record names it, and a publish under another login refuses, naming the owner. A cloud session cannot set a status, so publication runs on the trusted host or from a maintainer's CLI.

### 12. The git adapter

It keeps what the superseded decision got right:

- The branch is `melian/state` on the repository's own remote. A cloud session's proxy refuses other refs.
- Melian builds each commit with git's plumbing, in the clone's object database, and never checks the branch out.
- A branch holding anything the adapter does not know is refused whole, before a byte is read in part or pushed over.
- Every push names the tip it fetched with `--force-with-lease`. A lost race fetches again and retries, waiting a random time below a bound that doubles from 50 ms to a second, and gives up after ten in a row.
- A fetch or push stops at a two-minute wall-clock deadline. A push stopped there counts as landed when the tip is the commit it sent.
- When the branch cannot be reached, a review works locally and adds its records later. `melian publish` and the gate refuse without the store.

What changes: one commit holds a whole batch, since one push took 3.3 seconds in [issue #370](https://github.com/melian-agent/melian/issues/370); a record is a plain JSON file at `changesets/<changeset>/<kind>/<hash of key>/<id>.json`; and the lease, the sealing, the copy locks, the clone ID and the set-aside copies go.

### 13. Retention

Once a changeset's records are in the store, everything local is cache, and [issue #348](https://github.com/melian-agent/melian/issues/348) may prune it. The record is small enough to keep. `dispose` removes a changeset's records; reclaiming a git branch's history is the adapter's own housekeeping.

## What this gives up

- A runner killed in the middle of a lens reruns that lens. Only finished tasks cross hosts.
- Findings sit in plain text in the store before publication, readable by anyone who can read the repository.
- A dismisser from the CLI stays self-declared. A repository that must prove who dismissed uses the provider path.
- The record is a new stored shape, with versions to migrate and an import path to keep true, about 400 to 550 lines by [issue #372](https://github.com/melian-agent/melian/issues/372)'s estimate.
- The reopen rule, sighting merge and verifier lowering live in the pipeline, so a gate that is core alone needs them moved.
- A pull request whose markers were made under the per-changeset secret finishes on its local store.

## Work in flight

- `packages/state-git` on `main`, from [pull request #310](https://github.com/melian-agent/melian/pull/310), holds the superseded form until the git adapter replaces it.
- [Pull request #314](https://github.com/melian-agent/melian/pull/314) is frozen at `92faa656` by the maintainer's ruling of 2026-11-13, and does not land if this is adopted.
- This closes the need for [issue #317](https://github.com/melian-agent/melian/issues/317), [issue #307](https://github.com/melian-agent/melian/issues/307), [issue #319](https://github.com/melian-agent/melian/issues/319), [issue #340](https://github.com/melian-agent/melian/issues/340) and [issue #361](https://github.com/melian-agent/melian/issues/361), and settles [issue #154](https://github.com/melian-agent/melian/issues/154) by rule 11.
- The coverage drafts, [pull request #216](https://github.com/melian-agent/melian/pull/216), [pull request #218](https://github.com/melian-agent/melian/pull/218) and [pull request #220](https://github.com/melian-agent/melian/pull/220), are replanned as a projection of the record.

## For the attack

- A writer adds a record under another round's key, or a `supersedes` naming a dismissal or a blocking sighting. Does anything but "writers are trusted" stop it, and should it?
- Two rounds of one revision stand. Is the worse verdict the right rule, and can a writer use a second round to block or to pass?
- The gate is computed. What does it need that a merge-group runner lacks, and does every miss fail closed?
- A marker's value is public once posted. Can a commenter copy it into another comment during the window before the `post` record lands?
- [Issue #373](https://github.com/melian-agent/melian/issues/373) never ran the reopen case that needs the diff's hunks. Does a computed verdict equal the stored one there?
- A check record from a host with another tsc or Biome: does comparing the tool's version in the payload refuse it?
- A store other than the repository's branch, whose writers drift from the repository's. What does Melian say, and to whom?
