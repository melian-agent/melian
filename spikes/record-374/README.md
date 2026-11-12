# Spike: which of publish's provider calls work from a cloud session

For [issue #374](https://github.com/melian-agent/melian/issues/374), under the rules of [issue #368](https://github.com/melian-agent/melian/issues/368). Scripts, not product code.

`calls.mjs` opens a scratch draft pull request from the branch `melian/spike-374`, tries each GitHub call `melian publish` makes through the session's proxy with Octokit, as the CLI would, and closes the pull request at the end. Run it from the checkout with `NODE_USE_ENV_PROXY=1`, after pushing the scratch branch. `results.json` holds the run against [pull request #375](https://github.com/melian-agent/melian/pull/375).
