# Pin the verifier conversation limit

[Pull request #80](https://github.com/melian-agent/melian/pull/80), ninth Melian round.

No test exercised more than eight candidates. Raising the worker limit could
start every judge at once without a regression.

The new test stores nine distinct candidates and holds the fake judge's requests
open. Eight requests must start while the ninth waits. Releasing the judge lets
all nine candidates finish. The test also measures the maximum requests in
flight and checks every candidate outcome.

Removing the eight-worker limit fails with nine requests in flight.
Restoring eight passes. Production scheduling and architecture decisions are
unchanged.
