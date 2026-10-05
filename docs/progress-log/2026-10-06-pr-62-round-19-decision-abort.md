# Decision cancellation reaches the decider

The nineteenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) found that no test observed cancellation at the durable task's decider.
The new regression parks a decider inside its request, aborts the task, and checks that its signal and abort listener both observe cancellation.
The task settles aborted without storing an answer or failure, and review runs the lens at its default level.

The test passes with the combined task and timeout signal.
It fails when a temporary mutation forwards only the timeout signal.
No runtime change was needed.
