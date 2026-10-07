# Tool manifest and upstream Enola

Choice: Pin official Enola v0.4.27 for Darwin and Linux, on amd64 and arm64. Each release checksum agrees with GitHub's asset digest. The inspected Darwin ARM64 archive holds a platform-named binary, LICENSE, and NOTICE. Melian extracts only the named binary.

Upstream [pull request #342](https://github.com/enola-labs/enola/pull/342) merged `impact`. The fork plan has no remaining user, so this decision removes it instead of retaining a general fork workflow.

The root `tools.yaml` belongs to Melian, never the reviewed repository. `ToolManifest` uses strict TypeBox validation over YAML. Pins hold version, repository and tag, publication time, and platform URL, hash, and optional archive path. An absent archive path describes a standalone executable. The top-level `misses` list maps comparison finding IDs to a named tool or run.

The gate checks release age against `.npmrc`, publication time against GitHub, and each pinned digest against the release. Lookup failure fails closed. Enola's two-day window ends at 2026-10-07 16:37:02 UTC. A dated exception permits this spike because it needs `impact`, with the four checksums cross-checked. The maintainer can accept that exception or wait.

Supersedes: 2026-10-04-enola-caller-query.md
