# Build plan draft: `melian gate` and the merge-group check from the shared record

Draft for [issue #395](https://github.com/melian-agent/melian/issues/395), step 46's build 4. This is a plan only. No code was written. The one push is the scratch-branch probe in section 4.

Line numbers name `main` (`origin/main` as fetched on 2026-11-16) or "the top branch". The top branch is the head of the unmerged stack: [pull request #476](https://github.com/melian-agent/melian/pull/476), then [#496](https://github.com/melian-agent/melian/pull/496), [#502](https://github.com/melian-agent/melian/pull/502), [#481](https://github.com/melian-agent/melian/pull/481) and [#475](https://github.com/melian-agent/melian/pull/475). Those branches will change before they land, so read every top-branch line number as approximate.

## 0. What the stack looks like now

The plan assumes the stack lands first, as the coordinator said. It is not a straight line, and the order matters for the moves in section 1:

- [#476](https://github.com/melian-agent/melian/pull/476), the minimal reader, sits 48 commits ahead of `main` and 43 behind. It is not based on current `main`.
- [#496](https://github.com/melian-agent/melian/pull/496), which keeps outside text out of records, is based on #476.
- [#502](https://github.com/melian-agent/melian/pull/502), the account's resolution policy, forks from an older #476 commit (`4c2941b6`), not from #496.
- [#481](https://github.com/melian-agent/melian/pull/481), the dismissal record, is based on #502.
- [#475](https://github.com/melian-agent/melian/pull/475), resuming from imported records, is based on #481. It merged an older #496 (`a4c72237`) and lacks #496's newest commit, `1366b09f`, which replaces outside text with `withheld`.
- [#489](https://github.com/melian-agent/melian/issues/489)'s branch (`claude/exciting-cannon-qqj4k7`) merged #481 and [#493](https://github.com/melian-agent/melian/issues/493)'s branch (`claude/serene-goldberg-qj8jnf`). It takes the verification task to version 6 and `VerdictDocument` to version 16.

Build 4 should start from `main` once all of these have landed, never from one of these branches.

## 1. What moves into core, and from where

[The shared record decision](https://github.com/melian-agent/melian/blob/main/docs/decisions/2026-11-13-shared-record-behind-a-store-port.md), under "What this gives up", says the reopen rule, the sighting merge and the verifier's lowering live in the pipeline, "so a gate that is core alone needs them moved". Today the only reader of a round is `RecordedRound` in `packages/pipeline/src/recorded-round.ts` (top branch, 220 lines). It needs all three, plus four more pipeline modules.

### What `RecordedRound` reaches today

`RecordedRound.verdict(context)` (top branch, `recorded-round.ts:90-123`):

- builds producers from `account.producers`;
- builds proving hunks with `reviewFiles(...)` and `provingHunk` from `lens-tools.ts`;
- merges sightings with `mergeSightings(...)` from `findings.ts` (line 99);
- reads the policy with `configsFor` from `configurations.ts` (line 102) and compares its fingerprint with the account's `resolutionPolicy` (lines 103-110);
- decides with core's `new Adjudication({... verificationRan: account.checks.includes("verifier") ...}).adjudicate()` (lines 112-123).

`piecesOf` (lines 137-188) uses `accountKey` and `inManifestOrder` from `review-records.ts`. `dismissalsOf` (lines 190-202) takes the latest dismissal by `at`.

### The reopen rule

Where it is now, in `packages/pipeline/src/findings.ts` (top branch):

- `triggerCode` (line 277), `proofOf` (line 282) and `unionOf` (line 288).
- `reopens(hash, proof, cause, trigger, hunks)` (lines 331-342), the rule itself:

  ```ts
  return proof.length > 0 && cause !== "introduced"
    ? hunks !== undefined && proof.some((each) => !hunks.some((hunk) => hunk.file === each.file && hunk.hash === each.hash))
    : hash !== trigger;
  ```

  When `hunks` is undefined, a reader that cannot read the hunks takes the dismissal as reopened, which matches rule 7.
- Its callers are `reopenedAt` (line 293), `dismissalChanged` (line 318), `reopenDismissals` (line 345), `mergeSightings` (lines 788-837) and `Predecessors.#stands` in `restatement.ts:127`.

Where it goes: a new `packages/core/src/reopen.ts`, or methods on core's `Finding` and `Dismissal` in `core/src/findings.ts`. The AGENTS.md rule says a function whose first parameter is a `Finding` is a method. `reopens` takes a hash, a proof, a cause and a trigger, which are all fields of one finding's sighting plus the dismissal's trigger. So the move should make it `dismissal.reopensAt(finding, hunks)` or `finding.reopens(trigger, hunks)`. It must not stay a free function. The hunk type (`{ file, hash }`) moves with it. `provingHunk` itself is a `lens-tools.ts` helper that hashes a diff hunk; core already parses diffs (`Diff.parse`), so the hunk hash belongs on core's diff hunk.

### The sighting merge

Where it is now, in `findings.ts` (top branch):

- `adjudicate(sightings, judged)` (lines 200-228) is the merge of one finding's sightings. The highest severity after lowering wins, a tie goes to the source by `compareSources` (lines 186-192), and it sets `originalSeverity`. It uses `severityRank` (line 184).
- `selected(producers)` (line 231), `judgedAt` (line 921) and `judged()` (line 941).
- `mergeSightings` (lines 788-837), the record-side entry. #476 added it, and #481 changed lines 792 and 817-833 to apply dismissals through `reopens`.
- `verificationClaims` (line 746), `SharedDismissal` (line 778) and `Producer` (line 685).

Core already holds the second-stage merge: `Defect`'s merge by shared cause in `core/src/adjudication.ts:143-182`, through `mergeClaims` in `core/src/findings.ts:1459`.

Where it goes: a `Sightings` class in core (for example `core/src/sightings.ts`), built by `Sightings.of(records, producers)` with `merge(dismissals, hunks)` as a method. `adjudicate` and `selected` become its private helpers. `Producer`, `SharedDismissal` and `VerificationClaim` move to core as types.

### The verifier's lowering

Most of it is already in core:

- `Finding.original()` (`core/src/findings.ts:1282`), `lowered()` (line 1287), `verifiedAs(verification)` (line 1311) and `trustFloor` (line 1652).
- `Lowering` (`core/src/verification.ts:80`) and `VerificationRecord` (line 107).
- `Defect.trustFloor` (`core/src/adjudication.ts:216`).

What stays in pipeline is the part that applies a verification to a sighting: `judged()` (`findings.ts:941`) and the original-versus-lowered handling inside `adjudicate` (lines 200-228). These move with the sighting merge above. The verifier's report tool (`lens-tools.ts:1160-1220`) stays in pipeline, since it is the producer, not the reader.

### What the reader also needs, which the decision does not name

1. **`configsFor`** (`pipeline/src/configurations.ts`). The reader compares the account's resolution policy fingerprint with the base policy's. The gate must read the base policy anyway (rule 9 fails closed on an unreadable base policy). The fingerprint is computed in pipeline (identity table: "Resolution policy fingerprint, `pipeline/src/configurations.ts`"). Either it moves to core with the code that computes it, or the gate stays a pipeline consumer. See open question 1.
2. **`accountKey` and `inManifestOrder`** (`pipeline/src/review-records.ts`). `accountKey` is the request key of the revision plus the records counted. It is a pure function over core types and `KeyedRequest.of`, so it can move to core beside `record-payloads.ts`.
3. **Proving hunks from git.** Rule 7 says the reopen uses "the revision's proving hunks from git". `reviewFiles` lives in pipeline and runs git. Core already has git helpers (`core/src/git.ts`), so the gate can read the diff through core and parse it with `Diff.parse`.
4. **Inheritance.** `Predecessors` (`restatement.ts:32-156`), `recordInheritances` (`findings.ts:1146-1184`), `floored` (line 1131), `standing`, `identityOf` and `linked` (lines 839-882), and `dismissedRoots` (line 1072) all read Pi documents. None of it is in the record reader today. That gap is case 2 of [issue #506](https://github.com/melian-agent/melian/issues/506) (section 3). The gate does not need it to match the minimal reader, and moving it is a larger job than the other three.

### Conflicts with the stack and with #489 and #493

| File | Touched by | Where |
| --- | --- | --- |
| `pipeline/src/findings.ts` | #476, #481 | #476 at lines 166-178 and 740-803; #481 at 743-833 |
| `pipeline/src/recorded-round.ts` | #476 creates it; #502 and #481 change it | throughout |
| `pipeline/src/restatement.ts` | #481 | lines 15, 23, 36, 43, 46, 63, 84-91 |
| `pipeline/src/review.ts` | #489, #493, #496 | #489 changes 105 lines; #493 at `unanswered` (about 616-622) and the skipped count (about 694-697); #496 at 1293, 3049 and 3649 |
| `pipeline/src/lens-tools.ts` | #493 | `describeProbe`, about line 1330 |
| `pipeline/src/adjudication.ts` | #489 | `VerdictDocument` 15 to 16, about line 160 |
| `core/src/adjudication.ts` | #489 | `answeredAt` on `CheckLineage` about line 337; a `Verdict.all()` comment about line 613 |
| `core/src/record.ts` | #476 | lines 46, 268, 336-352, 437-455 |
| `core/src/record-payloads.ts` | #502 | lines 281, 292 |

One latent clash: `record-payloads.ts` (top branch, lines 80-92) declares the check lineage schema strict, with no `answeredAt`. #489 adds `answeredAt` to `CheckLineage`. Once both land, a check record written under #489 carries a field the strict schema refuses, and the whole set fails (as #475 rules: a known version with a bad shape fails the set). Whichever lands second must add the field, as optional, to the v1 schema or bump the check payload. Build 4 must not assume either.

### Move order

1. Wait for the whole stack, #489 and #493 to land. Every file in the table above is touched by at least one of them.
2. Move the reopen rule first. It is the smallest piece, with no Pi dependency, and both other moves call it. Leave a one-line re-export in `pipeline/src/findings.ts` so callers in `review.ts` and `restatement.ts` keep compiling. Do not touch `review.ts` in this commit.
3. Move the sighting merge and lowering application (`adjudicate`, `selected`, `judged`, `judgedAt`, `mergeSightings`, `verificationClaims`) as one class. `reopenDismissals`, `upsertFinding` and `upsertVerification` stay in pipeline, since they write Pi documents, and call the core class.
4. Move `accountKey` and `inManifestOrder` to core.
5. Decide `configsFor` by open question 1.
6. Stay clear of `core/src/adjudication.ts` around `CheckLineage`, so no lane that follows #489 conflicts there.
7. Delete the re-exports in the last commit of the piece, once nothing imports them, so the Biome free-function rule sees no new free domain functions.

## 2. What the gate and the merge-group check read and refuse

Rule 9 and the issue's "Done when" give the cases. Each row names where the check fails closed and what it reads.

### What the gate reads

1. **The store.** `GitRecordStore.open` (`main`, `state-git/src/git-record-store.ts:70`) fetches `melian/state` (line 85), then `list` (line 161) returns the changeset's records, fresh or failing (rule 3).
2. **The base policy**, from the pull request's base commit: `trust.writers`, `trust.host.key`, tiers and resolution policy. Read it before trusting any record.
3. **The record set.** `RecordSet.of(records, counts)` (top branch, `core/src/record.ts:395`), where `counts` is `everyRecordCounts` (line 366) or a filter built from trust. The set's `standingRounds(changeset, revision)` (line 429), `account(round)` (line 442) and `missing(round)` (line 460) are already in core.
4. **Each standing round's verdict**, by the moved `RecordedRound` logic.
5. **The pull request head and base**, from GitHub, to name the revision and the changeset.
6. **The proving hunks** of that revision, from git.

### Cases, from "Done when" and rule 9

| Case | Outcome | Where it fails closed |
| --- | --- | --- |
| Store unreachable (fetch fails, deadline passes) | Exit non-zero, not reviewed | `GitRecordStore.open` / `list` throw `RecordError("unreachable")` (`repository.ts:358`). The gate catches nothing below its top level |
| Record not found: no record for the changeset | Fail | after `list`, when the set is empty |
| No standing round at the head | Fail | after `standingRounds` returns empty |
| Base policy unreadable | Fail | before the store is read; the policy decides who counts |
| A round names no account, or more than one | That round reads not reviewed | `RecordedRound.piecesOf` (top branch, `recorded-round.ts:137-188`) |
| Account's key does not match the records it counts | Not reviewed | `piecesOf`, `accountKey` check |
| Account's resolution policy differs from the base's | Not reviewed | `verdict`, lines 103-110 |
| A named record is missing from the set | Not reviewed | `set.missing(round)` |
| A record carries a later payload version | Set aside, so the round that names it reads not reviewed | `RecordSet.of` via `reviewPayloads` (#475's rule) |
| A known version with a bad shape | The whole set fails | `RecordSet.of` |
| A record from an author the policy does not trust | Does not count | the `counts` filter; trust is write access (rule 6), so a record on `melian/state` counts unless `trust.host.key` is pinned and the record is unsigned or signed by another key |
| A fork's head job hands over an account or a dismissal | Refused | `SharedRecord.refusedFromHeadCode` (top branch, `record.ts:339`), and the account decision |
| A blocking finding in any standing round | Exit 1 | worst-of rule |
| An unresolved acknowledge finding | Exit 1 | maintainer ruling of 2026-11-13, under rule 9 |
| Not reviewed in any standing round | Exit 1, ranked worse than blocking | worst-of rule |
| Every standing round passed or holds only advisories and policy notices | Exit 0 | |

Two parts of rule 9 have nothing to act on yet:

- **"Worst standing round."** The decision that a round replaces none (`docs/decisions/2026-11-16-a-round-replaces-none.md`, on [#476](https://github.com/melian-agent/melian/pull/476)'s branch) leaves every `replaces` empty until #395 decides who may replace what. With nothing replaced, every round at the revision stands, so the gate takes the worst of all of them. One not-reviewed round, say one a provider outage cut, then fails the gate forever at that head. The only way past it is a new push, or the override. That is the behaviour rule 4 asks for until replacement exists, but the plan must say it plainly. Open question 2 asks who may name a round in `replaces`.
- **`recordedFindings`** in the CLI (top branch, `packages/cli/src/commands.ts:794-859`) decides every round at the revision with `RecordedRound.of(stored, id, () => true)`, sorted by ID. It applies no standing or worst-of rule, and it throws unless `trust.writers` is true. The gate must not copy it. The gate needs one core method, for example `RecordSet.gate(changeset, revision, policy, hunks)`, that `melian findings --records` can also call to show rounds.

### Dismissals

Rule 7 says any standing dismissal dismisses the finding, and a re-dismissal supersedes the ones it lists. #481's reader instead takes the latest dismissal record by `at`, with a tie going to the greater ID (`dismissalsOf`, top branch, `recorded-round.ts:190-202`). No writer sets `supersedes` on a dismissal yet. The two agree while there is one dismissal per finding. They disagree when a person dismisses, the finding reopens, and a second dismissal on a later sighting arrives. The gate must follow rule 7: drop superseded records (`RecordSet.superseded`, top branch, `record.ts:419-425`), then dismiss if any standing dismissal still holds under `reopens`. Open question 3 asks the coordinator to confirm.

#481's dismissal record has an empty `rounds`. Rule 7's late-round reopen is "computed from every sighting in the set that the rounds named by the dismissal do not hold". With `rounds` empty, that is every sighting in the set. So the gate re-tests every sighting, which is the stricter reading. Keep it.

### The merge-group check

Today `MergeGroupStatus.validate()` (`main`, `packages/cli/src/merge-group.ts:73-117`) does this:

1. It checks the event, `base_ref` `main` and the `head_ref` pattern.
2. It requires exactly one `ALLGREEN` `MERGE` queue rule (lines 87-93).
3. It checks the group commit's two parents, and that the second is the pull request's head (lines 94-98).
4. It reads the head's `melian/review` status (line 99). It requires `success`, a `User` creator with write permission, a `target_url` naming the pull request, and a description ending `; base <sha>`.
5. It runs `git merge-base --is-ancestor` of that base against the group's base (line 114).

`post()` (line 54) then writes the status on the group commit. `.github/workflows/melian-review-group.yml` runs it with `contents: read`, `statuses: write` and `pull-requests: read`.

The rewrite keeps steps 1 to 3 and the ancestor test. It replaces step 4 with the gate computed from the record:

- A round counts for the group when its head is the entry's head and its base is an ancestor of the group's base (rule 9). That is the existing ancestor test, applied to each round's base, not to the status's.
- It lists the store again just before it writes (rule 9). A dismissal added after the first read is then seen. A record added after the second list is the window below.
- The maintainer's override on the head counts unless a standing round holds a blocking finding (rule 9). The override's form is the one [the outage decision](https://github.com/melian-agent/melian/blob/main/docs/decisions/2026-10-23-melian-review-outage-procedure.md) gives: `description="Maintainer override: Melian could not run; base <sha>"`, context `melian/review`, `target_url` the pull request. [Issue #173](https://github.com/melian-agent/melian/issues/173) tracks a `melian status override` command to post it. The check keeps today's checks on the override's creator: a `User` with write permission.
- With the store unreachable, the check copies no override from the head; the maintainer posts on the group commit instead (rule 9). So "store unreachable" fails the group whatever the head's status says.
- The workflow needs `contents: read` on `melian/state` to fetch it, which its token already has. It needs nothing more, since the check never writes to the store.

### The window

The coordinator raised finding `382161a9c2805c6d`, the window between the gate's read and its write: the status carries nothing of the set it was computed from. A dismissal or a round added between the last list and the post does not change a status already written. A record that would fail the gate can land after a `success`. Two ways to deal with it:

1. **Close it.** Put a digest of the set's record IDs in the status description, beside the base. A later reader can then tell which set a status came from. That changes a string other code reads, and the description has a 140-character limit, so a 16-hex digest fits but a list does not.
2. **Measure it.** Record the time between the second list and the post, and accept it, as the round workflow's report accepts a host publication landing between its read and its post.

The coordinator asked to be consulted before either is chosen. Open question 4.

## 3. How much of issue #506 this build covers

[Issue #506](https://github.com/melian-agent/melian/issues/506) lists three ways the record reader differs from the host, which #481's decision names:

1. **No earlier verification on a dismissed finding.** The host keeps a verification on a finding across a dismissal; the record reader has only the round's own verification records. Build 4's gate reads what the rounds name, so it inherits this difference unchanged. Not covered.
2. **Inherited dismissals read live.** The host records inheritance through `recordInheritances` (`findings.ts:1146-1184`) and `Predecessors`. The reader has no inheritance at all, so an inherited dismissal does not dismiss. Not covered, unless section 1's inheritance move is pulled in, which would add about 600 lines and every file in the conflict table.
3. **The unverified cap applies only when the account names the verifier.** The host caps an unverified finding whenever verification was meant to run. The reader caps only when `account.checks` includes `verifier` (`recorded-round.ts:112-123`). Build 4 can close this one cheaply, if the account's `checks` is taken as the authority for "meant to run". That is a one-line rule in the moved reader and a test.

A fourth difference #481 names, that records are never withdrawn, is a design property of the store, not a reader bug.

So build 4 covers case 3 at most, and leaves cases 1 and 2 to #506. The gate is stricter than the host in case 2: a finding the host would show inherited-dismissed stays open, and blocks if it is blocking. That fails closed, which is acceptable for a gate, but it means the gate can block a pull request the host review passed. Open question 5 asks whether that is acceptable for the first required version.

## 4. Who may write to `melian/state`, and by what route

### How a cloud builder adds a dismissal record, tested

I ran the probe on 2026-11-16 in this cloud session, with the maintainer's agreement in the session. It used a scratch branch, `claude/scratch-395-push-probe`, never `melian/state`:

1. A plain push of a new parentless commit created the branch. git's push negotiation printed a warning, and the push landed.
2. A second commit, whose parent was the first, went up with `--force-with-lease=<ref>:<first>`, the adapter's exact route (`repository.ts:320-358`). The push landed as a fast-forward.
3. Deleting the branch failed both ways. `git push --delete` got HTTP 403 from the proxy, and `DELETE repos/.../git/refs/heads/...` got "Write access to this GitHub API path is not permitted through this proxy". The scratch branch is still there, at `8f2606df`, until the maintainer deletes it.

[Spike #370](https://github.com/melian-agent/melian/issues/370) had already pushed and leased `refs/heads/melian/spike-370`, so the proxy accepts a branch name outside `claude/`. The two results together mean `melian dismiss`, run in a cloud session, can add a dismissal record to `melian/state` by the git adapter, unchanged. The record's author is the session's git identity, and the push uses the session's GitHub grant, which has write access. So the record counts under rule 6 with `trust.writers` true. With `trust.host.key` pinned it does not count, since a cloud session holds no host key.

What a cloud session cannot do:

- Delete a ref. A design that deletes `melian/state`, or a per-changeset ref, cannot run from a cloud session. `dispose` writes a new commit, so it is unaffected.
- Push a non-fast-forward. I did not test it, since it would rewrite a branch. [Issue #361](https://github.com/melian-agent/melian/issues/361)'s compaction, if it rewrites history, should run on the host.

If the push is refused, for example because a later ruleset blocks the session's grant, the route is the host: the maintainer runs `melian dismiss` there, or a builder asks the Host Finisher to. The authority is rule 7, which counts a dismissal from a writer only, and rule 6, which makes write access to `melian/state` the trust. A builder never works around a refusal by writing the record to another ref, since no reader reads one.

### What the decision and issues say

- **Write access is the trust** (rule 6). With `trust.writers` true, anyone who can push `melian/state` is trusted, so the branch's protection is the trust boundary. `trust.host.key` must be pinned when `trust.writers` is false, or when the repository takes fork pull requests. Records then also need the host's signature.
- **A job that runs head code hands over only a review's kinds** (rule 6). It hands over check, lens, verification, walkthrough and triage records, never dismissal, account, post, status or ledger records. `SharedRecord.refusedFromHeadCode` (top branch, `record.ts:339`) and the `writerRelayed` and `forkRelayed` sets (lines 58-69) enforce it. A fork's head job never hands over an account (the account decision).
- **Dismissals** count only from a writer, through `melian dismiss` (the git author, self-declared) or through the provider (signed by the trusted host) (rule 7).
- **Disposal**: only a writer's command calls `dispose` (rule 13). `GitRecordStore.dispose` is at `main` `git-record-store.ts:190`.
- **The route** is the git adapter (rule 12): plumbing commits (`repository.ts:288-318`), pushed with `--force-with-lease` on the fetched tip (`repository.ts:320-358`), retried up to a two-minute deadline. A refusal because the branch moved is retried; anything else is an error.
- **The cloud proxy** lets a session push a branch, but refuses `refs/melian/*` and deleting a ref ([spike #370](https://github.com/melian-agent/melian/issues/370)). So `melian/state` must stay a branch, under `refs/heads/`.

## 5. The ruleset for `melian/state` in issue #463

[Issue #463](https://github.com/melian-agent/melian/issues/463) asks for a ruleset on `melian/state`. From the rules above, it must:

**Allow**

- Ordinary pushes by writers. Every adapter push is a commit whose parent is the fetched tip (`repository.ts:312`, `commit-tree ... -p <parent>`), leased on that tip (line 337). So every push that lands is a fast-forward, even though it carries `--force-with-lease`. A ruleset that blocks non-fast-forward pushes does not refuse it.
- Branch creation once, by a writer, for the first record. A push leased on no branch (`--force-with-lease=<ref>:`) creates it.
- The `melian round` workflow's report job, if build 4 or a later one makes it write records. That job would push with `MELIAN_STATUS_TOKEN` as `melian-status-bot`, which has write permission.

**Refuse**

- Deletion of the branch.
- Force pushes, meaning non-fast-forward updates. That keeps every record ever written in history, which is what "records are never withdrawn" relies on.
- Pushes from anyone without write permission. GitHub refuses those already; the ruleset need not restate it.

**Watch**

- Required status checks, required pull requests and required signatures must stay off for this branch. Any of them would refuse the adapter's direct pushes.
- If [issue #361](https://github.com/melian-agent/melian/issues/361) compacts the branch's history, that is a non-fast-forward push. The ruleset then needs a bypass for the one actor that compacts, or compaction must keep the old tip as an ancestor.
- `dispose` (rule 13) must not rewrite history either. It removes a changeset by a new commit, so a fast-forward-only rule allows it.
- The merge-group workflow only reads the branch, so it needs no bypass.

## 6. The split into stacked pieces

The total is roughly 1,800 to 2,400 changed lines, under the 3,000-line split rule, but each piece is a separate concern with its own review. Each is stacked on the one before. All five guard trust, since they decide what a verdict blocks, so each owes the hand mutation proof.

| Piece | What it does | Size, roughly | Files |
| --- | --- | --- | --- |
| (a) Reader rules into core | Moves the reopen rule, the sighting merge and the lowering application into core classes, with re-exports in pipeline, then removes them. Moves `accountKey` and `inManifestOrder`. No behaviour change: every existing test passes untouched | 400 | new `core/src/sightings.ts`, `core/src/findings.ts`, `pipeline/src/findings.ts`, `pipeline/src/review-records.ts`, `pipeline/src/recorded-round.ts`, `restatement.ts` (import line only) |
| (b) The gate in core | `RecordSet.gate(...)`: standing rounds, worst-of with not reviewed ranked worst, the unresolved-acknowledge rule, dismissals per rule 7 (supersedes, any standing one, late-round reopen), the account-names-the-verifier cap (#506 case 3), and the fail-closed cases in section 2's table | 500 | `core/src/record.ts`, new `core/src/gate.ts`, `pipeline/src/recorded-round.ts` |
| (c) The store from the CLI | A `--records git:` store spec and a default of `melian/state` on the clone's `origin`, opening `GitRecordStore`. `melian dismiss` adds a dismissal record, with `supersedes` naming the dismissals it replaces. `melian findings --records` shows standing rounds through (b) | 400 | `cli/src/commands.ts` (lines 275-330, 794-859), `state-git` |
| (d) `melian gate "#N"` and the merge-group check | The command, its exit codes and its output. The merge-group check rewritten on the gate, listing again before it writes, with the override rules and the window mechanism of open question 4. The workflow change | 600 | new `cli/src/gate.ts`, `cli/src/merge-group.ts`, `.github/workflows/melian-review-group.yml`, `docs/design.md`, a decision file |
| (e) Inheritance from the record | #506 case 2. Probably left to #506 | 600 | `restatement.ts`, `findings.ts`, core |

Piece (d) is the only one that changes what blocks a merge. Make it its own pull request, and give the rule it implements a short attacking review first, as Converging requires for a ruling that changes blocking behaviour. Today the merge group copies the head's status. After (d) it computes the verdict, so a pull request whose round passed on the host but whose records fail the gate stops in the queue.

Piece (c) writes real records to `melian/state`. [Issue #463](https://github.com/melian-agent/melian/issues/463) expects build 4 to do that, and the ruleset of section 5 must be in place first. No CLI path calls `GitRecordStore` today; `--records` takes `dir:` only (top branch, `commands.ts:321-330`).

## 7. Stored shapes and keys

### Shapes

| Shape | Change | Version |
| --- | --- | --- |
| Dismissal record envelope | Starts carrying `supersedes`, naming the dismissal records a re-dismissal replaces. Rule 4 already allows `supersedes` on dismissals, so the envelope needs no version change | envelope unchanged; dismissal payload stays v1 |
| Dismissal payload `rounds` | Stays empty, unless open question 6 decides `melian dismiss` should name the rounds it saw. Filling it narrows the late-round reopen, which is a change in trust behaviour | v1 if left empty; a v2 if its meaning changes |
| `melian/review` status description on the group commit | Possibly a set digest beside the base, by open question 4. The merge-group check reads `; base <sha>` from the end today (`merge-group.ts:99-113`), so a digest goes before it or the parser changes | not a stored document, but a string another reader parses |
| Round `replaces` | Possibly filled, by open question 2. `ReviewRecords.round` already takes the list, so no payload version changes | round payload v1 |
| Pi documents | None. The gate reads records only | |

### Keys, with identity-guideline rows

The rows below use the table in `docs/guidelines/identity.md` on `main` (lines 45-109).

- **Dismissal key: the finding ID.** Rule 5 sets it. Add a row, or extend the Record slot row (line 66), saying: a dismissal record's slot is its finding ID, so a re-dismissal shares the slot and may supersede. Left out: the reason, the person, and the sighting's revision, so a re-dismissal on a later push still names the same slot.
- **Round ID: the round record's ID.** Already covered by the Record ID row (line 63). The gate decides "same round" by it, and sorts by it, so no new row. The row's "When it matches" column should add "the gate counts it once".
- **Account key** (`accountKey`). If it moves to core in piece (a), its row moves from the pipeline table to the core table. Its exclusions are what the account decision (`docs/decisions/2026-11-16-account-record.md`, on [#476](https://github.com/melian-agent/melian/pull/476)'s branch) and [#502's decision](https://github.com/melian-agent/melian/pull/502) say: the revision's request key, the records it counts, and the resolution policy fingerprint.
- **Set digest**, only if open question 4 chooses it. A new row: built in `core/src/gate.ts`. When it matches, Melian takes a status as computed from that set. Left out: records outside the changeset; superseded records, unless the digest is to show them too. It must be the SHA-256 of `canonicalJson` of the sorted record IDs, never a list of fields beside them.
- **Resolution policy fingerprint** (line 90). Unchanged, but the gate becomes a new place where a match decides whether a round counts. If `configsFor` moves to core, its row moves too.

## Open questions for the coordinator

1. **Must the gate be core alone?** The decision implies it, but the reader also needs `configsFor` for the policy fingerprint and git for the hunks. Moving `configsFor` pulls the whole configuration loader toward core. Is a gate in the CLI that calls pipeline's `configsFor` acceptable, with only the record rules in core?
2. **Who may name a round in `replaces`?** Until someone does, one not-reviewed round fails the gate at that head forever, and only a push or the override gets past it. Should build 4 decide this, for example letting a later round by the same writer at the same revision replace an earlier one? Or should it ship worst-of-all and leave replacement to a later issue?
3. **Latest dismissal or any standing one?** #481's reader takes the latest by `at`. Rule 7 says any standing dismissal dismisses, and a re-dismissal supersedes. Should build 4 replace #481's rule with rule 7's, and have `melian dismiss` write `supersedes`?
4. **The window (finding `382161a9c2805c6d`).** Close it with a set digest in the status description, or measure it and accept it? The coordinator asked to choose before any change.
5. **Gate stricter than the host.** Without inheritance (#506 case 2), the gate can block a pull request the host review passed. Is that acceptable for the first required version, or must #506 case 2 land first?
6. **Should `melian dismiss` fill the dismissal's `rounds`?** Empty means every sighting is re-tested, which is stricter. Filling it is rule 7's intended reading, but it changes trust behaviour and may need a payload version.
7. **The store's spec and default.** Is the default `melian/state` on `origin`, as rule 12 suggests? Should a missing branch mean "record not found" (fail) or "store unreachable" (fail, and no override copied)? The difference decides whether the maintainer posts on the group commit.
8. **When does `melian/review` on the merge group move to the gate?** Should it be in (d) itself, or behind a policy switch that runs the gate beside the copied status for a period first, as the shadow rule did for Codex's review? Rule 9's "Still open" notes that no review has run the gate on a merge-group runner.
9. **How is the override detected on the group commit?** Rule 9 says the maintainer posts on the group commit when the store is unreachable. The check runs before any such post. Does the maintainer re-run the check, or does a second status context carry the override?
10. **#489's `answeredAt` versus the strict check lineage schema.** Who adds the field to the record payload, and as an optional v1 field or under a payload bump? Build 4 must not land before that is settled, since a strict refusal fails the whole set.
11. **Ruleset order.** Must [issue #463](https://github.com/melian-agent/melian/issues/463)'s ruleset be in place before piece (c) writes the first real record?
