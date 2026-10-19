# Reasoning telemetry: installed adapter coverage

[Pull request #153](https://github.com/melian-agent/melian/pull/153), pass 3, starts at 20740b5d.

Codex found that capture dropped Bedrock's adaptive effort while retaining its thinking object. The regression first failed on the installed adapter's actual payload. Capture now retains additionalModelRequestFields.output_config.effort, and the model summary renders that effort.

One offline test builds a high-reasoning request through every installed chat API with a reasoning-capable catalogue model. The catalogue selects the APIs, and the test checks their installed module files. All ten expose a non-empty observed setting. Nine reach a stubbed fetch that answers nothing. Bedrock uses the AWS SDK and ignores fetch, so its callback captures the real body and throws before client.send. No adapter is silently skipped.

The probes run under Node because Vite selects the AWS SDK's broken extensionless ESM export. The test also calls capture directly on each returned payload, so related mutation runs cover capture in their own process.

Removing the Bedrock path fails the capture regression. Removing its rendering fallback fails the model-summary assertion. The report records the failing runs, restored tests and whole gate. This fix pass leaves the implementation plan unchanged.

Validation: formatting, type checking, tooling and the audit threshold pass. The whole gate exits 1 with 4,896 tests passing and 53 skipped. Three real-process tests report ps failed: undefined. The supervisor termination test reports toolFailed instead of invalidOutput under the same sandbox limit. These are the four failures recorded in pass 2. There are no timeouts. The host gate and automatic mutation round remain with the coordinator.
