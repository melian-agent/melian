# Count standards carriers by their raw bytes

[Pull request #85](https://github.com/melian-agent/melian/pull/85), twelfth round, finding efeea9a7cf25b2f0. A carrier holding the Latin-1 byte 0xE9 reported three bytes from both sources. Decoding replaced it with a three-byte UTF-8 character.

Both sources now expose readBytes through the same checks and bounds as readText. Text readers decode those bytes; StandardsInventory counts them directly. Tests cover a one-byte invalid sequence, valid multibyte text and an empty carrier from each source. Each case fails on the original inventory and when decoded-size accounting returns.

All 138 source and standards tests pass. Symlink warnings, oversized metadata and source failures keep their existing tests. The core guideline records the encoding trap. No design decision changes.
