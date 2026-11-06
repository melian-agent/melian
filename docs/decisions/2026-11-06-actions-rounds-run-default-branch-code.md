# Actions rounds run only the default branch's code with the logins

Choice: the `melian round` workflow runs only when dispatched from the default branch. That commit supplies Melian, which reviews the pull request as `"#N"`, and every helper script that runs while a login is present. A pull request's base and head are review data only.

Why: fix pass 1 of [pull request #275](https://github.com/melian-agent/melian/pull/275) built Melian from the pull request's base commit, so that the head could not change what judges it. Melian's round on that head showed the base is no safer. A pull request can target another writer's unmerged branch, and `gh workflow run --ref <branch>` lets any branch supply the workflow's scripts. Either way a branch no review had passed could run with `CLAUDE_CODE_OAUTH_TOKEN` and the Codex login. The default branch is protected and every change to it is reviewed, so it is the one revision a writer cannot choose on the day. The maintainer chose this over keeping the base as the build and refusing pull requests whose base is not the default branch.

Melian's round on the next head showed that the code is not enough: `melian review "#N"` reads `melian.yaml` and every lens from the pull request's base, so a base a writer chose could still supply a policy that runs no checks. The gate therefore also refuses a pull request whose base is not the default branch, as the maintainer chose over trusting a writer's base.

What this gives up: a stacked pull request gets no Actions round until its parent lands and it retargets to the default branch. A host round from the branch's own build still covers that case.
