`ReviewPlan.resolve` now keeps each route, `accept` or `--model` entry the catalogue does not hold on its tier as `unknown`. `warnings()`, doctor's `lines()` and the review's `summary()` report it. Each line names the file that set the entry: `melian.yaml` for a name the committed route holds, otherwise the preference file or `--model`. For an unknown provider it names the provider too.

Before, a misspelt model ID or a renamed provider ran on a fallback unannounced. Pi 1.1.0 renamed `azure-openai-responses` to `azure`. The review is not refused, since a newer pi-ai may hold the model, so no decision file. Scripted mode's stand-in catalogue sets `PlanInput.partialCatalog`, which skips the check.

The Codex adversarial review found the two points above: attribution by tier, and the false warnings in scripted mode. Failing tests came first, and each guard has a mutation that fails a test. See [pull request #140](https://github.com/melian-agent/melian/pull/140).
