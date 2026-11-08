# Restore the standards clauses that partial supersessions retired

Amends: [2026-10-06-oversized-standards-carriers.md](2026-10-06-oversized-standards-carriers.md) and [2026-10-06-standards-trust-provenance.md](2026-10-06-standards-trust-provenance.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

[The rendered cap](2026-10-06-rendered-standards-cap.md) superseded [the per-lens cap](2026-10-06-per-lens-standards-cap.md) while rebuilding its bound. [The oversized-carriers decision](2026-10-06-oversized-standards-carriers.md) then superseded the rendered cap for its individual-file failure rule only. [The provenance decision](2026-10-06-standards-trust-provenance.md) superseded [the worktree boundary](2026-10-06-worktree-standards-boundary.md) for how standards earn trust. The index retired each target whole. The clauses below still hold on main. This file restates them and changes nothing.

## From [2026-10-06-rendered-standards-cap.md](2026-10-06-rendered-standards-cap.md)

- The union bounds the rendered standards to 1 MiB and 1024 sections. It counts UTF-8 headings and trimmed content, reserves 128 bytes per section for boundaries and separators, and 1024 bytes for the lead-in.
- Tests measure the actual quoted renderer against the bound.
- A per-file union prefers each changed file's nearest scope, including imports from that scope. It drops other scopes first, retaining deepest-first and later-first order within each group.
- Flat arrays have no per-file chains and retain the old scope priority. Imported paths use their importer's scope.
- Any omitted standards leave the lens record ended and the verdict not reviewed. The lens still runs and may report findings, but it cannot claim complete coverage.
- Its note names up to ten paths within 4 KiB and the total omitted count.
- A host can narrow the lens to reduce its union.
- Refused imports also use a bounded note.

## From [2026-10-06-per-lens-standards-cap.md](2026-10-06-per-lens-standards-cap.md)

- Retained sections keep first-file order, nearest first within each chain, deduplicated at their first position.
- A section's content is never cut.

## From [2026-10-06-worktree-standards-boundary.md](2026-10-06-worktree-standards-boundary.md)

- The lead-in asks the lens to check the change against the repository's conventions.
- The quote function replaces an embedded nonce so content cannot close its own boundary.
- A file absent from a pull request's base is never read merely because its head adds it.
- The host still chooses the source, and configuration still reads from it.
