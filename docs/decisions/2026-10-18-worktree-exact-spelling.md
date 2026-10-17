# Worktree reads require the exact directory entry spelling

Supersedes: [2026-10-18-case-variant-policy-paths.md](2026-10-18-case-variant-policy-paths.md)

For [pull request #147](https://github.com/melian-agent/melian/pull/147), pass 4.

A case-insensitive filesystem can open `LENſ.md` as `LENS.md`.
JavaScript's `toLowerCase()` leaves the long s unchanged.
The pass 3 classifier and the review of record found two instances of this class.
A folding table would repeat the mistake: the filesystem decides which name opens.

WorktreeSource compares each requested component with its actual name from `readdir` before opening the path.
A component without an exact match makes the path absent.
Do not fold or normalise either name.
This applies to every source operation that opens repository content, including lens and standards reads and directory listings.
An alias cannot define a lens or hide a farther lens's coverage.
RevisionSource is unaffected: it already reads exact names from Git trees.

Keep pass 3's case-insensitive classification as a second check.
Classify `.melian`, `.agents`, `lenses` and `LENS.md` case-insensitively.
Policy membership beneath `.melian`, analyser paths and package-manifest checks do too.
Recognised policy files still draw their notice even when a worktree read refuses them.
Every changed recognised lens blob retains its forced notice and acknowledgement floor under a disabled parent.
The scope scan recognises aliases but marks a nearer scope only when the source can resolve the canonical lens file.
Symlinked entries still reach refusal.
Scope and lens names keep their original spelling and identity; configured globs keep their existing semantics.
Git blob reads, findings and triggers keep the path's original spelling.
The nested policy rule's blob comparison, resolution protection, dismissal binding and accepted residual risks remain in force.

The three review probes run on case-insensitive filesystems.
On other hosts they skip with a reason; directory-read stubs exercise the same exact comparison on every host.
No model call is needed to prove the boundary.
