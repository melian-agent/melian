# Use the repository spelling for the capture field

[Pull request #153](https://github.com/melian-agent/melian/pull/153) names the new optional JSON field catalogMapped. Code uses US spelling; prose still uses catalogue. No main record contains this new field.

The expectation changed first. Three catalogue-mapping cases failed because the capture still wrote catalogueMapped. They pass after renaming the field in the type, capture and renderer. All 55 reasoning tests pass. Three further mutations prove the capture key, renderer key and optional-field filtering. The earlier 78 mutation proofs remain in the local report. The whole gate was rerun: 4,889 passed, 53 skipped and four ps-denial sandbox failures. Biome, type checking and audit passed. No telemetry test failed.
