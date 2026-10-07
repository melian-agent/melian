# Prove standards guards and scope bounds

The mutation inventory for [pull request #85](https://github.com/melian-agent/melian/pull/85) adds 22 standards cases. They distinguish loaded directories from file paths, retain root and import-only scopes, count separator bytes and preserve typed source errors. Existing cache and carrier-list assertions also become stricter. Each mutation fails its named test.

File paths made the directory fallback look correct. Directory fixtures now exercise refusal notes, nearest preference and oversized omissions through their loaded scope. No production behaviour or design decision changes.
