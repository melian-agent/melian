# A lens's standards union has a cap

Problem: one path has bounded standards, but a lens over many packages can collect an unbounded union.

Example: six packages each carry a 256 KiB `AGENTS.md`. Every single chain fits, but their union cannot fit a 1 MiB prompt budget.

Solution: keep the typed errors for an oversized file or single chain. Bound each lens's union to 1 MiB of content. Drop whole sections from the deepest scope first, then later sections at equal depth. An import has its importer's scope. Keep retained sections in first-file order, nearest first within each chain, deduplicated at their first position. Record the omitted count and paths on that lens's check record. Never cut a section's content or fail a review solely because its union spans many packages.

Supersedes: 2026-10-03-repository-content-bounds.md, for unions across paths only. Individual reads and single chains still fail with typed errors.
