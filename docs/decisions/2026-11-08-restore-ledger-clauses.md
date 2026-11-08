# Restore the ledger clauses that partial supersessions retired

Restores clauses for [2026-10-06-ledger-review-author.md](2026-10-06-ledger-review-author.md) and [2026-10-06-walkthrough-settled-attempts.md](2026-10-06-walkthrough-settled-attempts.md): the active decisions the partial `Supersedes:` chains below ended in. It declares no graph edge, so each of them can be superseded on its own.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

Where a clause below conflicts with any other active decision, including the ones named above, that decision wins. These clauses fill gaps the partial supersessions left; they override nothing.

[2026-10-05-ledger-publication-projection.md](2026-10-05-ledger-publication-projection.md) superseded [2026-10-04-review-ledger.md](2026-10-04-review-ledger.md) to change its configuration spelling, the stamp's plan and the prompt's grouping. [2026-10-05-ledger-recovery-and-bounds.md](2026-10-05-ledger-recovery-and-bounds.md) superseded both: the ledger decision for discovery, ownership, ordering and retained history, and the projection decision for its digest and summary failures. The two decisions named above then superseded the recovery decision for unrecorded ownership and for attempt accounting. The index retired each target whole. The clauses below still hold on main; this file restates them and changes nothing.

## From [2026-10-04-review-ledger.md](2026-10-04-review-ledger.md)

- Publication maintains one comment Melian owns per pull request, the ledger. The first publish creates it, and every later publish edits it in place. It carries a signed marker and a hidden, versioned JSON stamp with the base, head, verdict and counts.
- The ledger's comment ID is recorded in a changeset-level document, not the per-revision `published` document, because one comment spans every revision. A replay re-renders the ledger rather than reposting it.
- A publish that finds a ledger marker it cannot verify, as after the clone holding the signing secret is lost, refuses and names the recovery. It never posts a duplicate ledger.
- Until milestone 3, the recovery is deleting the orphaned comment by hand; the next publish then starts a new ledger with a new secret. From milestone 3, the recovery is restoring the changeset's storage from the state branch.
- The ledger's first visible line under its heading names the base, the head and the round.
- The walkthrough holds a paragraph, a table of file or layer to summary, and a sequence diagram where one applies.
- The walkthrough setting switches it with `enabled`, `collapsed` and `diagrams`.
- A summariser task on the `light` model tier writes the walkthrough, reading head content inside prompt boundaries. It renders through the same escaping as findings, labelled a summary and never a verdict.
- Each earlier round is trimmed to a line as the body nears GitHub's limit of 65,536 characters.
- When a finding resolves, Melian edits its original inline comment to append the commit that addressed it, and resolves the thread.
- `melian findings` and the ledger carry an agent prompt that opens by saying the finding text, paths and code are untrusted review data.
- Melian never edits the pull request description; a one-line pointer there is optional.
- The ledger is a projection of the durable store, never a source of truth. `melian findings --json` is the interface; nobody parses the markdown.

## From [2026-10-05-ledger-publication-projection.md](2026-10-05-ledger-publication-projection.md)

- The walkthrough settings live under `publish.walkthrough`, not `publication.walkthrough`.
- The stamp names the plan by a fingerprint of the recorded manifest, routes, levels, budgets and standards paths.
- The summarise task runs in the review harness. Publishing reads its stored output.
- Publishing never asks a model, so the GitHub provider's token is the only credential it uses.
- A small sequence-diagram syntax allowlist keeps diagram text from becoming links or executable directives.
- The agent prompt uses one fence containing every open finding. Its opening untrusted-data rule applies to all findings, and an agent can copy the whole block.

## From [2026-10-05-ledger-recovery-and-bounds.md](2026-10-05-ledger-recovery-and-bounds.md)

- Publication sets the status first, posts the review and closes findings, then discovers and writes the ledger.
- A ledger problem updates the status with recovery instructions.
- Discovery fetches the recorded ID first.
- Installation tokens use the recorded ID and author when `/user` cannot identify them. An unknown author never authorises an edit of the recorded ledger.
- A damaged own ledger requires deleting the comment by hand. An orphaned ledger can also recover by restoring storage.
- The stamp digest must equal the ledger marker ID exactly.
- The projection fingerprint hashes the exact final bounded visible body, excluding the marker and stamp. Readback checks both digests.
- Separator characters are escaped in stamp JSON.
- The summariser runs only for pull-request targets.
- The summariser has one recording tool, which rejects unknown properties, copies bounded known fields and validates file paths against the change.
- The summariser's output cannot render autolinks.
- The walkthrough has its own size budget and is cut before dismissals, run details or the prompt.
- Provider details stay out of fixed failure notes.
- Failure notes are stored apart from successful summaries, so another review retries. Once the two-attempt limit is reached, the note stands until `--rerun`, which also refreshes a successful summary.
- A summary problem never changes the review exit code.
- Once a later round posts, older stored rounds retain only base, head, round number and status.
- The stored history keeps the newest 50 rounds.
- A base-only retarget adds one round.
- Removing a finding's marker prevents its edit but still allows thread resolution, recorded as null.
- An abandoned round keeps the ledger link.
- Document upgrades are one way. An older Melian that opens a state directory a newer one has migrated fails every command, because Pi Durable refuses a document newer than its code. Pruned rounds cannot be restored. Share a state directory only between Melians of one version.
- The summariser resolves its light model through the plan stored with the verdict's provenance.
