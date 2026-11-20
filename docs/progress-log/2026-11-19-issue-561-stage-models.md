# Issue 561: each parity stage names its model and effort

The host's early read of six misses at fcd13237 ran the design lens on a model its policy did not route, and nothing in its results said so. The coordinator asked on 2026-11-19 that the parity run's results file name each lens's model, and its requested and provider-reported effort.

Each stage in the results file now records `models`, the models that answered it, and `effort`, the reasoning effort its requests asked for and the effort the provider reported, each value once in request order. Both come from the stage's own telemetry, the usage it recorded per model and per request, so the run reads no route of its own. A dry run on main's policy showed the design lens keeps its own route, gpt-5.6-sol at high, in both arms, whatever the prober's tier; the results file is now where a live run shows it.

A new test in `packages/evals/test/parity.test.ts` records a stage of three requests, one with no reported effort and two with different ones, beside a stage with no requests. Three hand mutants fail it: dropping the deduplication, reporting a value for a request that reported none, and recording no models.
