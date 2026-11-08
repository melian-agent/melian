# Pinned tools download through GitHub's release API when a token is set

Amends: [Release metadata offline](2026-10-06-tool-metadata-offline.md), where a pin's bytes come from

Status: accepted on 2026-11-08 by the maintainer, who set out the fix in [issue #345](https://github.com/melian-agent/melian/issues/345).

Problem: from about 09:00 UTC on 2026-11-08, GitHub's public release URLs answered HTTP 504 while its API served the same assets. `ToolCache` fetched only the pinned public URL, so `static.enola` failed and every `melian round` read not reviewed.

Choice: when `GITHUB_TOKEN` or `GH_TOKEN` is set, `ToolCache` asks the release API for the release named by the pin's `source`, finds the asset whose `browser_download_url` is the pinned URL, as the gate's release check does, and downloads it by id. It follows the asset's redirect itself and sends no token there, so the token reaches `api.github.com` alone. When GitHub refuses the token with HTTP 401, as it can a cloud session's, the cache asks the API once more without one, since public releases need none. Any other API failure falls back to the public URL. The pinned SHA-256 still decides: a mismatch or an oversized body on the API path is refused, not retried at the public URL, since both serve one asset.

Why: the release API is the authority the gate already asks, and a token changes only where the bytes come from, never what is accepted.
