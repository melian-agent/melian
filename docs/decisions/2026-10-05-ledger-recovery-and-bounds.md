# Ledger recovery and bounds

Supersedes: [2026-10-04-review-ledger.md](2026-10-04-review-ledger.md) for discovery, ownership, ordering and retained history; [2026-10-05-ledger-publication-projection.md](2026-10-05-ledger-publication-projection.md) for the projection digest and summary failures.

Problem: another commenter could block ledger discovery, and a damaged own ledger could leave a stale successful status. The stamp did not detect edits to the visible body. A failed summary was cached as success, and old rounds retained all their detail.

Example: a stranger copies the public marker onto a comment. A token that cannot identify its user then treats that stranger's comment as the mutable ledger.

Choice: publication sets the status first, posts the review and closes findings, then discovers and writes the ledger. A ledger problem updates the status with recovery instructions. Discovery fetches the recorded ID first. Marker scans skip other authors when the login is known, and otherwise the signature decides; a lookalike that fails it refuses the write. Installation tokens use the recorded ID and author when `/user` cannot identify them; an unknown author never authorises an edit of the recorded ledger. A damaged own ledger requires deleting the comment by hand. An orphaned ledger can also recover by restoring storage.

The stamp digest must equal the ledger marker ID exactly. The projection fingerprint hashes the exact final bounded visible body, excluding the marker and stamp. Readback checks both digests. Separator characters are escaped in stamp JSON.

The summariser runs only for pull-request targets. It has one recording tool, which rejects unknown properties, copies bounded known fields and validates file paths against the change. Its output cannot render autolinks. The walkthrough has its own size budget and is cut before dismissals, run details or the prompt. Provider details stay out of fixed failure notes. Notes are stored apart from successful summaries, so another review retries; `--rerun` can refresh a successful summary. A summary problem never changes the review exit code.

Once a later round posts, older stored rounds retain only base, head, round number and status. A base-only retarget adds one round. Removing a finding's marker prevents its edit but still allows thread resolution, recorded as null. Thread discovery is cached for one publication. An abandoned round keeps the ledger link.

Why: the durable store remains the source of truth. The status must describe the current review even when its optional ledger needs recovery. A mutable comment needs ownership as well as a public signature. Display history and summary prose must have bounds independent of the findings that need action.

Upgrade: the document upgrades are one way. A Melian from before this change that opens a state directory a newer one has migrated fails every command, because Pi Durable refuses a document newer than its code (`PublishedDocument` 5, `VerdictDocument` 5, `LedgerDocument` 2). Pruned rounds cannot be restored. Share a state directory only between Melians of one version.

With the review plan: run details read the model a lens finished on and its lineage from the plan's records, and the summariser resolves its light model through the plan stored with the verdict's provenance.
