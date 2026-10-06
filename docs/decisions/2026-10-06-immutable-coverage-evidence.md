# Keep coverage evidence immutable and reuse by producer

Supersedes: 2026-10-06-coverage-artifacts.md (cache layout and lookup only).

A repeat review overwrote review-coverage.json while the check record retained its old content ID. Graph coverage could also survive a compiler or matching algorithm change.

Store complete artifacts at coverage/<graph-input-key>/artifacts/<kind>-<content-id>.json. Validate their content hash when reading. Keep this namespace outside the graph entry, which repair may replace. Publish an atomic index for each producer after its artifact. Graph indexes include the installed TypeScript version, matching algorithm version and schema. Review indexes include the durable nonce and conversation IDs, hashed as a run identity. Test indexes include the placeholder schema.

An explicit content-ID lookup reads historical evidence. Automatic lookup checks the current producer and, for graph coverage, the artifact's compiler identity. Review lookup requires a run identity or content ID. Old files without producer indexes are misses; they cannot prove compatibility. Existing artifact shapes and durable coverage IDs stay unchanged. Matcher or transcript semantics changes must bump their producer identity. No coverage runs head tests.
