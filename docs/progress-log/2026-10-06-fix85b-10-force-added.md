# Refuse ignored imports even when committed by force

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 10.

Existing import tests did not distinguish git check-ignore with and without --no-index. The new fixture force-adds a private file excluded by the committed ignore rule. It proves the blob is tracked, then asserts the import is refused with its note before readText runs.
