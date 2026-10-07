# CLI caller wiring

Confirmed fe8eef9ab46c01ac for [pull request #89](https://github.com/melian-agent/melian/pull/89). The CLI test enables Enola, supplies a fake CallerContext and uses the fake model. It asserts caller text reaches that model and the coverage ID survives findings --json. Removing the callers option fails; restoration passes. No provider or analyser runs.
