# Recorded review errors stay inert in the terminal

The F10 probe for [pull request #135](https://github.com/melian-agent/melian/pull/135) found that `review` printed a recorded `ReviewError` directly. A fake provider’s exhausted route put an escape sequence into that error.

The regression completed the failed review and failed because standard error held the raw escape. Passing the message through `visibleText` makes it pass. No live provider was called. The raw-message run is also the deletion proof for this escaping call.

Targeted regression: passed. The whole gate remains part of the telemetry pass; its final result belongs in that pass’s entry and report.
