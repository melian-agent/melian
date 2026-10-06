# Authenticate cached executables from pinned archives

Supersedes: 2026-10-06-tool-cache.md (executable authentication only).

A writable sidecar lets a replacement executable authenticate itself. Retain the downloaded archive. Every cached use verifies its hash against the reviewer-owned manifest, extracts the selected binary in memory, and compares that digest with the executable. Verify regular files, bounds and executable mode as before. Old entries without archives are misses and fetch repairs them. Receipts remain lineage, never authority.

This spends local decompression on readiness and reuse. It binds the executable to the reviewed archive pin without adding unverified binary hashes to the manifest.
