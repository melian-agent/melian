# Assert typed standards failures

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 13.

The remaining chain rejection used rejects.toMatchObject, which would accept a plain object with the right code. It now uses the repository rejection helper with StandardsError and asserts totalTooLarge. The deferred oversized-root regression uses the same helper and asserts tooLarge.
