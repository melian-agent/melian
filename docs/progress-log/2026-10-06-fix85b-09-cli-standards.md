# Pin range standards at the CLI boundary

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 9.

Core and pipeline safety tests did not exercise the CLI's standardsSource selection. The new CLI regression observes its fake-model request after replacing a committed nested AGENTS.md with an uncommitted import. The lens receives the committed rule and neither checkout text nor the checkout-only import. Local configuration still selects the lens.
