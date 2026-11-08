For [issue #345](https://github.com/melian-agent/melian/issues/345), `ToolCache` now downloads a pinned tool through GitHub's release API when `GITHUB_TOKEN` or `GH_TOKEN` is set. From about 09:00 UTC on 2026-11-08, GitHub's public release URLs answered HTTP 504 while the API served the same assets, so `static.enola` failed and every `melian round` read not reviewed.

The cache asks for the release by the pin's `source`, takes the asset whose `browser_download_url` is the pinned URL, as `scripts/check-tools.mjs` does, and downloads it by id with `Accept: application/octet-stream`. It follows the redirect itself, with no token, so the token reaches `api.github.com` alone. Any API failure falls back to the public URL. A SHA-256 mismatch or an oversized body on the API path is refused, not retried. Release metadata is bounded at 4 MiB. [The decision](../decisions/2026-11-08-tool-fetch-through-release-api.md) records the choice.

The tests' fakes answer only a request with the right token, media type and redirect mode, and each fallback case lists the exact requests it expects. Against the head before the fix, the new tests failed because the cache asked the public URL first. A live fetch of Enola 0.4.27 with a real token went to `api.github.com` twice and then to `release-assets.githubusercontent.com`, while the public URL still answered 504.

Tests that pass a fake fetch to `ToolProvisioning.open` now pass `env: {}`, because CI sets `GITHUB_TOKEN` for the gate and would otherwise route them through the API.

The enumerator listed 81 mutants. 18 are ignored string literals. One is equivalent: dropping `?.` before `.id` turns a missing asset's guard error into a `TypeError`, and both fall back. The other 62 were each run by hand against their one named test, and all were killed.

Codex's adversarial review found that a token GitHub refuses with HTTP 401, as `scripts/check-tools.mjs` says a cloud session's can be, sent the fetch straight back to the failing public URL. The cache now asks the API once more without the token on a 401. Two new tests failed first, with `Download failed: HTTP 504` and a missing anonymous request, and pass after the fix.
