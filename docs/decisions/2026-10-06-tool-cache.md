# Verified binary cache

Choice: Use `ToolCache.open(root, { fetch })` and `materialise(tool, platform)`. Stream the download to a temporary file while hashing it. Refuse a mismatch before extraction. A small bounded tar reader uses Node crypto and zlib, without running a host program. It extracts only the named executable and rejects every link, absolute path, and parent traversal. A missing archive path means a standalone executable.

Each entry records the archive and executable hashes. Every use re-hashes the executable and repairs mismatches from the pinned download. Entries are published by rename after extraction; overlapping downloads can use a verified winner. The cache holds no resources between calls, so it needs no `close()`. Its root will follow the graph cache and the existing state-directory rule.

Why: The inspected release is a simple tarball. A bounded reader avoids inheriting a system tar's extraction options and never writes an unselected entry.
