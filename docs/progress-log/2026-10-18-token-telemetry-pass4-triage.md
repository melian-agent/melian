# Preserve triage spend on failure

[Pull request #146](https://github.com/melian-agent/melian/pull/146), pass 4, addresses final-round finding 1f76d203.
A three-pass measurement could lose pass one’s 100 tokens/$1 when pass two failed with 10 tokens/$0.10.
The failure now prints each attempted pass’s spend, including completed goldens, and saves the available telemetry before throwing.
The failed pass appears once. Incomplete goldens receive no score.

Regression tests failed on the starting head, then passed after the fix.
A fake-provider integration test proves that the JSON file exists before the failure reaches its caller.
Hand mutations cover the error receipt, pass records, output-path guards and failure propagation.
The inventory and logs are under tmp/token-telemetry-pass4-*; the final report records the full gate and CI result.
The implementation plan stays unchanged for this fix pass.
