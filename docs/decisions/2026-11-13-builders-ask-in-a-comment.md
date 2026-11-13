# A builder asks the coordinator in a comment

Amends: [builders ask the coordinator first](2026-11-13-builders-ask-the-coordinator-first.md), the channel a question travels by

The first rule said to ask "in a message to its session". On its first day, 2026-11-13, a cloud builder's messages to the coordinator's session failed, so it asked on [issue #346](https://github.com/melian-agent/melian/issues/346). The coordinator was not watching comments, the 30 minutes ran out, and the question went to the maintainer. Other builders waited on the maintainer in their own sessions. The maintainer raised it that day, in the coordinator's session.

A question goes in a comment on the issue or pull request, starting "Builder agent: question for the coordinator". GitHub is the one channel every builder can write and the coordinator can watch. The coordinator keeps a watch on those comments while lanes are open. A message to its session may accompany the comment and never replaces it.

Everything else in the first decision stands: what the coordinator may answer, the 30 minutes, and that its answer is no ruling.
