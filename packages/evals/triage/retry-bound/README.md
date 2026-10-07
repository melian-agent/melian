# retry-bound

Retry one more time and back off.

Right levels: `correctness` `careful`, `trust-boundary` `quick`.

A loop bound and a delay calculation change. Correctness plainly covers a boundary and ordering change; no outside input reaches a sink.

The levels are the maintainer's judgement of how closely each lens should look, and a golden is changed only with a note here saying why.
