# A deterministic rule resolves through the keys, and a configured guardrail rule under its own name

A deterministic rule resolves through the keys, and a configured guardrail rule under its own name. The root maps one Biome rule to `advisory`, the guardrail rule `focused-test` to `block`, and the guardrail rule `todo` to `advisory`. The change adds one line for each guardrail rule. Both report under `guardrail/forbidden-patterns`, and each resolves under its own key.
