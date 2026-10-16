# Stage telemetry: smaller design and Pi authority

[Pull request #135](https://github.com/melian-agent/melian/pull/135) adopts the attacking review's smaller design. Model timings come from transcripts. Deterministic timings belong to each task. pi-telemetry waits for Pi Durable to pass a context. Step 31 remains in progress.

Pi Durable 1.0.0 cannot supply a fault time. The fault-time regression first failed with missing start and end fields. Upgrading Pi Durable, pi-ai and Chord to 1.1.0 makes it pass. The lockfile changes six packages: these three, pi-telemetry transitively, Anthropic's SDK and Babel runtime. All releases satisfy the age policy.

No production branch changed in this piece. The implementation and its mutation inventory follow in this branch. No comparison record was edited.
