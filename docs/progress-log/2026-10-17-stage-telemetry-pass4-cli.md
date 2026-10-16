# Exercise timing commands in the test process

[Pull request #135](https://github.com/melian-agent/melian/pull/135), pass 4.

Ten new in-process tests cover telemetry dispatch, JSON and text output, absent storage, empty records, failed-read cleanup, target arity and the slowest-stage line after successful and failed reviews. Reviews use scripted models and a temporary repository. Detached reads use memory storage; no model or network call occurs there.

All 11 distinguishable CLI mutations named in the cold round fail these tests when applied by hand. The initial `jsonReview` value is overwritten after parsing, while parse errors return before the JSON handler. Changing that initial value is equivalent and passes both CLI suites. No suppression was added.
