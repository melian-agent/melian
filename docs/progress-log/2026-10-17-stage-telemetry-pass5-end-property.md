# Stage telemetry pass 5: absent end property

[Pull request #135](https://github.com/melian-agent/melian/pull/135).

The pass-4 proof for `1e299c12eea4b1de` mutated the duration guard on line 36. The host survivor instead replaced `endedAt === undefined` on line 35 with `false`.

A new reader test requires a running stage with no recorded end to omit the `endedAt` property. With the exact mutation applied, it fails because the returned row owns `endedAt: undefined`. Restoring the source passes all 28 reader tests. Logs are `tmp/stage-telemetry-pass5-1e299c12-false.log` and `tmp/stage-telemetry-pass5-1e299c12-restored.log`.

Finding IDs identify a source site, not a unique mutant. Proof records must name the original expression and its replacement. An `undefined` value assertion alone cannot prove that an optional property is absent.

Production code and step status stay unchanged. The implementation plan needs no status update.
