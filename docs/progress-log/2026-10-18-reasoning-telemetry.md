# Reasoning telemetry

Status: built; draft pull request pending.

Record each returned request's requested thinking level, observed sent reasoning settings and provider-reported level beside its usage. ReviewHarness observes generation and compaction through its host-supplied Models port. RouteTextModel forwards triage capture before validating the answer. Failover attempts retain separate receipts. No reasoning level changes.

Model-usage document version 2 preserves version 1 unchanged. A fixture recorded through main's decision task at a96c5447 proves reopening. Pi UsageDoc still supplies conversation totals. Receipt capture commits before Pi settles the response, so its own reported usage can be visible before it joins those totals.

Telemetry text and JSON, review JSON, terminal summaries and live golden spend expose the settings. Missing reasoning fields say provider default. A missing callback is derived, not observed. Terminal output escapes model and provider text.

Validation: eleven request scenarios fail on main's executable paths because capture is absent. Tests cover lenses, verification, triage, walkthroughs, compaction, failover, legacy usage, callback replacement, optional fields and pagination at 200 and 201 conversations. All 78 executed mutations are killed. The optional-field regression failed before its fix and passed afterwards. The targeted reasoning and triage-output run passed 60 tests.

The first whole gate passed 4,886 tests and skipped 53, with six failures. Two output assertions now include the required reasoning suffix. Four tests require ps, which the Codex sandbox denies. The second whole gate passed 4,889 tests and skipped 53. Its only four failures were the same ps denials. Biome, type checking and the dependency audit passed. No test or process guard was weakened.

Live model calls and subagents were forbidden. External model reviews and the host's full static.mutation run remain with the coordinator. The branch diff was reviewed locally. The builder report and complete mutation inventory are in tmp/reasoning-telemetry-report.md.
