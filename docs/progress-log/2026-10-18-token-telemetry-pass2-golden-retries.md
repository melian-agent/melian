# Token telemetry: golden retry modes

[Pull request #146](https://github.com/melian-agent/melian/pull/146) now probes a transient lens error followed by a successful answer. Live mode reaches the second fake response. Scripted mode fails after the first. No real provider runs.

Both tests pass against the restored source. Five hand mutations fail: retry always false, always true, the reversed mode comparison, an empty mode string and empty harness options. The inventory records each replacement and its failing output. The host text names only the first of four grouped replacements; their precise correspondence awaits the host export.

The initial probe also exposed an idle lens in the test’s script. The final test selects only the golden’s scripted lenses, and all five mutations were rerun against that test. The plan stays unchanged.
