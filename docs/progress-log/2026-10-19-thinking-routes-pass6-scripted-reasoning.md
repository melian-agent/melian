# Thinking routes: prove scripted reasoning stays unset

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 6, fixes round 2 finding `f80d47e8`.
The scripted-route test now records each fake provider request’s reasoning and requires it to be undefined.
The existing finding and tool-result assertions still check the script’s outcome.

Preserving the configured tier’s thinking passed the old test.
The same hand mutation fails the new assertion: four lens requests carry `high`.
Restoring the override leaves every request’s reasoning unset.
Telemetry records this default as `off`, so the test checks the provider options directly.
No production code changes.
The implementation plan’s status stays unchanged.
The pass report under `tmp/m2/scratch-thinking/` records validation and delivery.
