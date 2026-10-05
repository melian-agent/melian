# Verifier failover request model

[Pull request #80](https://github.com/melian-agent/melian/pull/80), seventh Melian round.

The failover test checked only the stored model label. Removing the configure call
still passed because the label changed separately and the scripted judge answered
whichever model asked.

The scripted judge now records each request's model ID. The test requires judge
for the failed request and backup for both later requests. Removing the configure
call fails this assertion; restoring it passes. The full verifier suite passes.

A stored label cannot prove which model received a request. Assert on the fake
provider's request model when testing routing.
