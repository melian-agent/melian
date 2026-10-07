# Git author mutation inventory

For [pull request #68](https://github.com/melian-agent/melian/pull/68), changing the default action fails the existing dismissal test. Replacing the action in the error with dismissal text passes it. Two direct tests pin the default action, the hand-match action and git's arguments. Both operators fail these tests; both restored tests pass. No design decision changed.
