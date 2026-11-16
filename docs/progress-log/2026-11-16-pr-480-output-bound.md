On [issue #480](https://github.com/melian-agent/melian/issues/480)'s branch, [pull request #498](https://github.com/melian-agent/melian/pull/498), core's `git` now stops the programs git started when its standard output reaches a call's `maxBytes`, as it already did at the deadline and past `stderrLimit`. Before, that bound stopped git alone. A program git started that kept git's output open then held the call until it exited too. Codex's adversarial review of `3a375395` found it.

The fix sends the bound through the same `stop()` as the other two, and resolves the cut result when the stop ends, with `childrenLeft` when it could not find or end the tree.

- The test came first. On `dd0f8167`, "stops the programs git started once its output reaches maxBytes, though one holds the output open" took ten seconds, the life of the child its stand-in starts. It passes with the fix, in well under a second, and finds the child ended.
