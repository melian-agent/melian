# Record oversized nested standards per chain

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 1.

A vendor carrier over 256 KiB raised StandardsError during eager loading. Regressions failed on both source kinds before the fix. Nested carriers now become named omissions; root carrier errors wait until a lens requests the chain. Fake-model tests cover uncovered, opted-out and covered vendor paths. The covered lens records incomplete coverage.
