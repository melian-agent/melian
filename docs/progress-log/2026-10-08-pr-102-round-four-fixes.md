# Round four fixes for [pull request #102](https://github.com/melian-agent/melian/pull/102)

“fix(decisions): resolve supersession links by destination” fixes ad5540759cef4c45. A dated link label no longer creates a second edge beside its nested destination. The regression covers both an absent root decision and an unrelated root decision that must stay active. Restoring label scanning fails that regression. The decisions test file passes. The full gate will run after the scoring fix.
