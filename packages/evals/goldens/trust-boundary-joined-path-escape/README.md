# trust-boundary-joined-path-escape

A host read through a joined path that `..` escapes. The change lets a pull request name its summary template, joins the name onto the checkout, and posts the file it read. The workflow runs on `pull_request_target` with a token that can write, so `../.git/config` publishes that token.

It tests the lens's probe "Does a `..` escape after the join?". The shape is finding 20 of the [comparison record](../../comparisons/2026-10-03-pr-12.md) for [pull request #12](https://github.com/melian-agent/melian/pull/12), where lens paths with `..` climbed out of the repository, which the backlog still lists for its own golden.
