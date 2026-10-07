# Durable Enola snapshot evidence

Confirmed fifth-round finding 93e9a9e46ec76d1f for [pull request #89](https://github.com/melian-agent/melian/pull/89).
Deleting runStatic's snapshot hand-off leaves all ten old check tests passing.

A mocked static runner supplies distinct base and head snapshots with separate receipts, cache keys and graph/test coverage IDs.
The regression checks the exact records returned by runChecks, readCheckRecords, reviewChangeset and readVerdict.
Deleting either the runStatic or CheckTask hand-off fails the new assertion; the ten old tests still pass.
Each mutation restores the production file in a finally block.
The restored check suite passes all eleven tests.
