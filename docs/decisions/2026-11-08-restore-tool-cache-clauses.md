# Restore the tool cache clauses that partial supersessions retired

Amends: [2026-10-06-tool-cache-authentication.md](2026-10-06-tool-cache-authentication.md) and [2026-10-06-tool-cache-publication.md](2026-10-06-tool-cache-publication.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

[2026-10-06-tool-cache-authentication.md](2026-10-06-tool-cache-authentication.md) and [2026-10-06-tool-cache-publication.md](2026-10-06-tool-cache-publication.md) each superseded [2026-10-06-tool-cache.md](2026-10-06-tool-cache.md) while changing one part of it: how a cached executable is authenticated, and how entries are published and repaired. The index retired the target whole. The clauses below still hold on main; this file restates them and changes nothing.

## From [2026-10-06-tool-cache.md](2026-10-06-tool-cache.md)

- Use `ToolCache.open(root, { fetch })` and `materialise(tool, platform)`.
- Stream the download to a temporary file while hashing it. Refuse a mismatch before extraction.
- A small bounded tar reader uses Node crypto and zlib, without running a host program. It extracts only the named executable and rejects every link, absolute path, and parent traversal.
- A missing archive path means a standalone executable.
- The cache holds no resources between calls, so it needs no `close()`.
- Its root follows the graph cache and the existing state-directory rule.
