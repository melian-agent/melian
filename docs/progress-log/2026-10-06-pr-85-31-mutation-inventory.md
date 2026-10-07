# Complete the deferred-issues mutation inventory

[Pull request #85](https://github.com/melian-agent/melian/pull/85)'s inventory covers 198 rows. Existing tests protect 171; this pass protects 27 more and adds 28 test cases. It reuses 76 earlier proofs. Every counted row has a failing behavioural test under its mutation. Local evidence is in tmp/inv85-inventory.md and tmp/inv85-report.md.

The thirteenth-round golden now distinguishes base and head standards. Both core rejection assertions use the required helper. The remaining fixtures guard directory metadata, caches, source-error translation, scope preference, separator bytes, doctor diagnostics, ignore cleanup, empty ledger standards and document reader boundaries.

Equivalent deletions and unreachable defensive arms are recorded separately. Preliminary probes that matched older doctor guards or used an invalid cache replacement are excluded. Corrected probes run against the old and strengthened tests. No production behaviour or design decision changes.
