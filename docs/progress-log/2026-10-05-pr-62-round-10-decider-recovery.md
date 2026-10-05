The tenth review of [pull request #62](https://github.com/melian-agent/melian/pull/62) found that resuming a decision with another decider stored a permanent failure under the original decider's key.

The task now ends aborted without writing an answer or failure. The mismatched review uses the default level. A SQLite test parks the decision, reopens with another decider, then reopens with the original and checks that it answers again. This preserves crash recovery: only unanswered work is retried, and committed answers stay attached.
