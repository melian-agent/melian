# A forbidden-patterns rule may set its own severity

Choice: a `forbidden-patterns` rule takes an optional `severity`, which overrides the guardrail's for that rule's findings. A line that several rules match gets the strictest of their severities.

Why: severity belonged to the whole guardrail, so every rule sat at `P2` and a reviewer had to acknowledge it. Documentation rules, such as an unlinked pull request number or a long sentence, are `P3` and advisory. Lowering the guardrail would have lowered `focused-test` and `dynamic-import` with them, and a nested `melian.yaml` cannot scope a rule that matches Markdown anywhere in the tree. A rule that sets no severity behaves as before.
