# Fallback cancellation reaches the model

The sixteenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) found no test proved the fallback forwarded its abort signal.

The new regression holds a stub text model call open, checks it received the decider's signal before cancellation, then aborts and checks the model's rejection passes through unchanged. Removing the signal argument makes the test fail. Production code stays unchanged.
