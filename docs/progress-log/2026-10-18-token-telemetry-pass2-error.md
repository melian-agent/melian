# Token telemetry: failed-run causes

[Pull request #146](https://github.com/melian-agent/melian/pull/146) now checks that GoldenRunError retains the original cause and detached telemetry. Both Error and string causes are covered.

Replacing the constructor options with `{}` makes both tests fail: the cause becomes undefined. Restoring the options passes both tests. The exact probe and logs are appended to tmp/token-telemetry-mutation-inventory.jsonl. This is a test-only fix; the plan stays unchanged.
