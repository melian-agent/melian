# Restore the Enola clauses that partial supersessions retired

Amends: [2026-10-06-tool-metadata-offline.md](2026-10-06-tool-metadata-offline.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

[2026-10-04-enola-caller-query.md](2026-10-04-enola-caller-query.md) superseded [2026-10-04-enola.md](2026-10-04-enola.md) while correcting only where constraint verdicts and callers come from. [2026-10-06-tool-manifest.md](2026-10-06-tool-manifest.md) superseded the caller-query decision to drop the fork. [2026-10-06-tool-metadata-offline.md](2026-10-06-tool-metadata-offline.md) superseded the manifest decision for a release-metadata lookup failure alone. The index retired each target whole. The clauses below still hold on main; this file restates them and changes nothing.

## From [2026-10-04-enola.md](2026-10-04-enola.md)

- Melian uses Enola's documented interfaces and never reconstructs its algorithms: the contract artifacts, versioned by `format_version`, for identity and lineage, and a command-line query with JSON output for callers. Melian never speaks MCP.
- Enola executes in the execution environment, like every tool that loads repository configuration, never in the Melian process.
- Enola's configuration files, for intent, constraints, suppressions, linking, and the `providers:` block that names an executable Enola runs, are policy read from the base and join the policy-change list. A committed baseline is never used.
- The graph is kept in a Melian-owned cache under the git common directory's melian directory, or under MELIAN_STATE_DIR when set, never on the state branch. An Actions cache backend for runners is deferred. The base snapshot is shared by every pull request on that base, and a miss recomputes.
- Coverage may budget `search` only where per-file call coverage for the graph, measured against ground truth (for TypeScript, the imports and calls tsc resolves on Melian's own tree), is adequate. A budget is a per-lens call budget where the graph covers a file's calls, with a reason on each call that the hook records. The spike's measurement found coverage inadequate, so `search` stays unrestricted.
- Enola's own `coverage_report` cannot serve: it measures edges between repositories, needs two or more in one graph, and an absent edge is not proof that no relationship exists.
- Enola is pinned in the manifest and refuses to compare across its own versions, which matches Melian's identity rule.

## From [2026-10-04-enola-caller-query.md](2026-10-04-enola-caller-query.md)

- Melian never runs Enola's upgrade command.

## From [2026-10-06-tool-manifest.md](2026-10-06-tool-manifest.md)

- Pin official Enola v0.4.27 for Darwin and Linux, on amd64 and arm64. Each release checksum agrees with GitHub's asset digest.
- Melian extracts only the named binary.
- Upstream [pull request #342](https://github.com/enola-labs/enola/pull/342) merged `impact`, so Melian keeps no fork of Enola.
- `ToolManifest` uses strict TypeBox validation over YAML. Pins hold version, repository and tag, publication time, and platform URL, hash, and optional archive path. An absent archive path describes a standalone executable.
- The top-level `misses` list maps comparison finding IDs to a named tool or run.
- The gate checks release age against `.npmrc`, publication time against GitHub, and each pinned digest against the release.
