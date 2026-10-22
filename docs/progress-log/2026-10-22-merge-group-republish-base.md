# 2026-10-22: republishing refreshes an older reviewed-base status

A settled publication can skip its status write. On [pull request #168](https://github.com/melian-agent/melian/pull/168), that left an older head status without the new reviewed-base suffix. The local record still matched its state, description and ledger URL.

Two regression cases first failed with `expected [] to deeply equal [ ObjectContaining{…} ]`. Neither republish wrote a status. One live status lacked a base; the other named a different base. The GitHub provider now accepts an optional reviewed base when reading the latest status. A missing or different suffix returns absent, so the publisher writes the current status without another review.

The two publication test files pass all 92 cases after the fix. Five hand mutations fail named tests: bypassing the suffix check, requiring a base on every read, dropping null handling, taking an older status, and omitting the requested base. The local inventory holds the commands and outputs. The builder reruns the whole gate before reporting.
