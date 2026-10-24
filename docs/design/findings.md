# Findings

Built in milestone 1, except the failure scenario, evidence, verification and `melian dismiss`, built in milestone 2 (review of record). Editing a resolved finding’s comment was built in milestone 2 in [pull request #73](https://github.com/melian-agent/melian/pull/73). Dismissal from a pull-request thread is planned for milestone 4 (comment commands).

### Schema

A finding is a SARIF `result` plus Melian extension properties. SARIF because semgrep, gitleaks, and eslint emit it natively, GitHub code scanning ingests it, and it forces a stable schema from the first commit. Extensions:

- `id`: stable hash of file, rule, a normalised snippet, and the snippet's occurrence: its zero-based ordinal among identical normalised snippets in that file at head, in line order. Survives line shifts and edits elsewhere in the file; inserting an identical snippet earlier renumbers the ones after it. A finding with no snippet supplies its own discriminator, such as the enclosing symbol or the hunk index. Used for cross-revision diffing and dismissal matching.
- `cause`: `introduced`, `affected`, or `pre-existing`. Location proves `introduced` only; `affected` needs a `cause` evidence location in changed code, which the pipeline checks against the hunks; everything else is `pre-existing`. See below.
- `trigger`: the diff hunk that caused the finding, named by its file and its index within that file: for an `introduced` finding the hunk it sits in, and for an `affected` one the first hunk a proving `cause` location falls on, by file then index, with a `proof` listing every proving hunk by file and the hash of its added and removed lines. Melian keeps the union of those proofs across sightings, so a dismissal of a finding outside the diff reopens only when a hunk that proved its cause changes, never because the lens cited more, fewer, or other locations. [The decision](../decisions/2026-10-04-affected-finding-trigger.md) says why.
- `failureScenario`: the input, state, or sequence that makes the code fail, and the wrong outcome it produces, as prose of at most 2,000 characters. Required of every lens finding; a static or guardrail finding has none.
- `evidence`: one to ten locations, each `{ file, line, endLine, role }`, holding the code the claim rests on. Required of every lens finding. `role` is `cause`, the code that brings the failure about, or `context`, code the claim reads but does not blame. A location may add `revision: base` to point at lines the change deleted, read from the base commit, so the removed-behaviour lens can show what was removed. Melian marks a base location `deleted` only when its lines overlap the change, and the GitHub comment says the change deleted them only then. Melian reads the snippet at each location from the head, or from the base for a base location, and stores it beside the location, so the verifier and the author read the same code the lens did. A location spans at most 60 lines, and every snippet a lens finding stores, its own and its trigger's included, is a display copy, cut at 2 KiB on a character boundary and marked as cut, so one long line cited ten times stores kilobytes, not megabytes. The finding's ID and its trigger's comparison come from the whole text, so the cut never changes either. Neither field enters the finding's ID: rewording a scenario or citing another line never makes a dismissed finding new.
- `otherClaims`: on a merged finding, each other member's failure scenario and evidence, with its ID, rule, and source, kept whole. See the [Merge step](../design.md#the-pipeline).
- `severity`: `P0` to `P3` plus `nit`. The rubric is fixed in version one, so `resolution` maps a closed set and a typo in configuration is an error. A repository-defined rubric is deferred until a user needs one.
- `confidence`: calibrated probability that the finding is real, from a decision model, planned for milestone 4. The LLM verifier never writes it: a text model's stated confidence is not calibrated, and one field holding both would spoil the calibration set.
- `verification`: the verifier's verdict, `confirmed`, `plausible`, or `refuted`, with its reason, an optional correction, the executor, the model, and the verifier's version. A correction is text shown beside the finding and never changes its severity, location, or ID. See [Verification](verification.md#verification).
- `resolution`: what this finding requires, after per-path configuration is applied. Only adjudication writes it, and it caps at advisory a `pre-existing` finding and a lens finding no verifier judged; a producer stores none, and a finding without one is unresolved. Problem: `report_finding` copied the severity's configured resolution, so a pre-existing P1 was stored as `block`. Solution: no tool decides what blocks.
- `status`: `new`, `open`, `resolved`, `dismissed`, `stale`.
- `dismissal`: who dismissed the finding, why, and when, while its status is `dismissed`; `pastDismissals` lists the dismissals that no longer stand, each reopened by a revision or replaced by a later dismissal. Both come from Melian's lifecycle record, never from a producer.
- `explanation`: what, why here, what to do. Written for the author.
- `source`: which check produced it, and the lens or question-set version.

Problem: a finding that names a line and a worry gives a verifier nothing to attack. Example: a lens reports that a parse call "may throw" and names no input that reaches it; a verifier can neither confirm nor refute that, so it survives as plausible and costs the author a reply. Solution: `report_finding` requires a failure scenario and at least one evidence location, and refuses a call without them, saying what each must be.

### Out-of-diff findings

Problem: a change inside the diff can break code outside it, and a lens reading outside the diff will also notice unrelated problems. Treating both the same either misses real breakage or turns every review into an audit.

Example: a pull request renames a function parameter. A caller in another file now passes the wrong argument. Meanwhile, that other file also has an unrelated SQL injection that predates the pull request.

Solution: classify by cause, not location. Location can prove only that a finding is in the diff; it cannot prove that a finding outside the diff was caused by it.

- `introduced`: inside the diff. In scope, can block. The only cause a location alone establishes.
- `affected`: outside the diff, provably caused by it. In scope, can block. Only evidence makes a finding `affected`, and evidence is structured, never prose: among its evidence locations, the lens names, with the role `cause`, the changed code that breaks the finding's location. Melian counts a location as proof only when its role is `cause`, its file is one the change modifies, and its lines overlap a hunk's new lines, or, for a location on the base, a hunk's old lines. A deleted guard is changed code, and a pure deletion has no new lines to overlap, so the base side is the only proof that case has. A file the change renamed without editing has no hunks at all, yet the rename is what the change did to it: any line of it counts as proof, at its old path on the base or its new path at head, so a consumer still importing the old path can be proved broken. It counts only for a finding in a file the change edited or left alone. No rename, its own or a sibling's, promotes a finding in a file the change only moved: moving files changes none of their lines, and `git mv` usually moves a whole directory, so an old defect in one moved file could otherwise cite another and block a pull request that only moved them. A `context` location never promotes a finding. No heuristic produces it.

Problem: evidence was free text, so a sentence promoted a finding to `affected`, which can block. Example: a lens wrote "`src/api.ts:3` renames `id`" for a file the change never touched, and an old defect blocked the merge. Solution: evidence is a location Melian checks against the diff and quotes itself, so prose cannot cross the cause boundary.
- `pre-existing`: outside the diff, with no evidence that the change caused it. The default for anything outside the diff. Never blocks. Appears once in a capped "noticed" section, is recorded in Melian's store, and is never raised again on that repository. An important pre-existing finding is listed under its own heading, once per finding ID per pull request, and then shown as carried, built in milestone 2, step 17. Built in step 18: a folder may cap a severity at `acknowledge` with `resolution.preExisting`. The finding is then treated as any `acknowledge` finding is. A pre-existing finding still never resolves `block`. [Verification](../design.md#lowering-a-severity) sets out the heading.

Static analysis gets the same split for free by running on base and head and diffing results.

### Cross-revision diffing

Problem: the step-10 rehearsal on [pull request #164](https://github.com/melian-agent/melian/pull/164) posted an advisory as a thread.
The ruleset required that thread to be resolved, so an advisory blocked the merge despite asking for no action.
The maintainer chose body-only advisories on 2026-10-22; [the decision](../decisions/2026-10-22-advisories-in-review-body.md) records it.
Each advisory carries its rule, a short summary and a file:line link to the head commit.
Only acknowledge and block findings can open inline threads; their existing line-placement rules apply.
An advisory raised to acknowledge or block gets a thread when its location permits one.
A finding lowered to advisory retires its old thread through the addressed-edit and resolution path.
An owed resolution stays owed while the finding remains advisory, including after a crash or a later push.

Publication, built in milestone 1, diffs each revision's findings by `id` against those of the revision published before. New findings are posted. Still-open findings are not reposted. When a finding resolves, milestone 1 replies in its thread that the revision no longer reports it, through `renderResolvedReply` in `packages/github/src/publication.ts`, and leaves the thread open. From milestone 2, with the [ledger](interaction-model.md#the-ledger), Melian instead edits the original inline comment to name the commit that addressed the finding, and resolves the thread. `melian dismiss`, built in milestone 2, records a dismissal with its reason in the findings document, and dismissal from a thread is planned for milestone 4. A finding posted earlier and then dismissed gets a reply in its thread saying it was dismissed and why, or, posted in a review's body, a line in the next body, and leaves the set of findings open on the pull request; the reply never names the dismisser. Dismissing a dismissed finding replaces its reason and keeps the old one in its history, and publication answers the thread again with the new reason. A resolution whose reply failed stays owed. An acknowledge or block finding that returns before the reply goes through reuses its own thread, alone or merged under another report. Dismissed findings stay dismissed unless the triggering hunk changes materially, which for now means the normalised code of the finding's trigger differs, compared whole through its hash even when the stored snippet is cut; a reopened finding keeps its old dismissal in its history and, if it was posted before, is posted again in a new thread.

Publication retires every resolution still owed against a thread in the commit that reuses it for a live finding.
Signed answer discovery spans every head, so a reply accepted before a lost checkpoint is not repeated on the next push.
Crash recovery takes a finding's root only from the review it recovered, by the comment's `pull_request_review_id`.
Either the journal or GitHub proves an answer present.
An addressed root still owes thread resolution even when its finding returns in a new thread.
Owed work and pending rounds keep every thread for a finding, keyed by finding, thread and dismissal version.
Published-document version 9 upgrades older resolution maps, including pending rounds, without changing their review payload.
A human-resolved live thread stays resolved: its finding still counts and appears in the next review body without another inline post. An acknowledge or block finding whose thread is open is not repeated in the body.
A returning finding cannot reuse it. Owed answers may still be posted there without reopening it.
GraphQL thread reads stay lazy, before reuse, reply, resolution or a review over still-open threads.
A root absent from GraphQL but present in REST has unknown state; publication waits rather than reusing or replacing it.
Publication sets the verdict's status before any thread or marker read, including recovery of an older pending round.
Bad or partial pages fail closed; listings stop at 50 pages, and malformed or repeated GraphQL cursors fail.
REST listings validate every record's IDs, author, body and comment links before consuming any page.
Publisher identity across tokens stays as before; [issue #154](https://github.com/melian-agent/melian/issues/154) holds it.
[The decision](../decisions/2026-10-18-owed-thread-returns.md) records the rules.
Built in [pull request #155](https://github.com/melian-agent/melian/pull/155), from the thread-state work of [pull request #145](https://github.com/melian-agent/melian/pull/145).

A policy-change notice hashes `blob:<base identity>:<head identity>` into the existing SHA-256 trigger field.
Git supplies the mode and blob. Regular and executable files use the blob identity; a symlink uses `symlink:<blob>`.
A change to or from a symlink therefore draws a notice even with equal blobs, and reopens a dismissal.
An absent side has an empty identity. A change to either identity reopens its dismissal, including a moved base with an unchanged head blob.
Unrelated pushes that preserve both identities preserve dismissal. Existing head-only triggers, older symlink identities and triggerless notices reopen once on their next report.
The shape and document version stay unchanged; reopening is the safe direction.
Check replacement compares the old sighting before removing stale reports, including on a rerun of the same revision.
A policy name whose non-UTF-8 bytes cannot be passed back to Git refuses the check, rather than reading as an absent blob.
Finding IDs stay unchanged. Findings document version 10 preserves version 9’s accepted trigger hash and affected proof hashes on each new dismissal. It also permits merged claims to retain their reported severity. Versions 8 and 9 migrate unchanged; earlier versions keep their evidence conversion. A fixture recorded by main at `748dfe37` proves that version 9 dismissals retain their content binding through SQLite reopen.
A sighting with different accepted content reopens it, even at an older revision or through an attached review task.
Reopening a cached sighting changes lifecycle alone and keeps its verification, so a confirmed code finding still blocks.
Older dismissals have no accepted trigger and retain their earlier rules.

The findings document keeps what a producer reports apart from Melian's lifecycle state: status, who dismissed a finding and why, and the first and last revisions that reported it. A lens or tool reporting a finding again replaces only its own record, so a dismissal survives every rerun.

What a producer reports is stored as immutable sightings, keyed by revision, its base and head commits, then lens name and version, and finding ID. A pull request retargeted onto another base keeps its head but has another diff, so it is another revision. Problem: one mutable record per ID raced across lenses and pushes. Example: two lenses that share a rule ID report one finding at one head, and the second either replaced the first's severity and source or was refused; or a crashed review of an old head resumes after the next push and rewrites the record the new head reads. Solution: a lens writes only its own sighting at its own head, and a replay or a correction replaces only that sighting. Reading a head merges its sightings per ID deterministically, as the [Merge step](../design.md#the-pipeline) sets out: the highest severity wins, a tie goes to the lens whose name sorts first, the winner keeps its own claim and takes the strongest cause with the locations that prove it, every other sighting's claim stays whole beside it, and `reportedBy` lists every lens that sighted it. No merge, of sightings or of one defect across checks, lowers what blocks. The lifecycle stays one record per ID, and the document lists the heads in the order their reviews started, so a resumed old head cannot move a finding’s last-seen revision back.
A new dismissal accepts the trigger at the revision dismissed, rather than at the last-seen revision.
Different trigger content reopens it regardless of revision order; matching content stays dismissed.
Affected findings still compare the accepted proof against the revision’s hunks, so changed citations alone never reopen them.
A dismissal accepts the whole accumulated proof union, plus its revision’s cited proof. It never drops earlier causes when that revision cites fewer hunks.

Local findings persist in the clone's `.git/melian/` directory, uncommitted. It sits in the git common directory, so every worktree of a clone shares one store and one set of dismissals. Until the state branch lands in milestone 3, a dismissal lives only there, and a second maintainer never sees it. Milestone 2 accepts that, because one maintainer reviews Melian. A range review and a pull-request review are separate changesets with separate storage, and never share findings. Whether a range review can seed a pull-request review, so the author is not told the same thing twice, is an [open question](../design.md#open-questions).
