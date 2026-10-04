# trust-boundary-clean-plugin

Written for the review of [pull request #42](https://github.com/melian-agent/melian/pull/42), not from a comparison record. Codex found that the trust-boundary lens's first wording read any head-supplied plugin, test runner, or build configuration as the head controlling its judge. Here the change adds a lint rule as a local ESLint plugin, which runs only in the pull request's own lint, so a review must report nothing.
