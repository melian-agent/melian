# Check source maps at first run and rerun

[Pull request #135](https://github.com/melian-agent/melian/pull/135), pass 4.

Two new cases check source maps through an initial run and a failed-check rerun, with the kept check's source present and absent. Forcing the stale-parent guard true fails: the first run creates an unwanted `undefined` family member. All 19 check tests pass after restoration.

Forcing the source-present guard true survives both cases. Pi omits the undefined property assigned to the fresh source map, so this mutation is equivalent. The local equivalents file records it; no suppression was added.
