# Single-repository policy stays enforced

On [pull request #89](https://github.com/melian-agent/melian/pull/89), removing either history disabling or repos removal now fails the policy test. The input enables history and names an outside repository. Six policy tests pass after both guards are restored.
