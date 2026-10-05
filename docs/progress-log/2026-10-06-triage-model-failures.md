# Failed fallback replies

[Pull request #62](https://github.com/melian-agent/melian/pull/62) now tests the text-model bridge's refusal of error and aborted replies.
Each fake reply carries a valid `answer` tool call choosing quick.
The error reply carries a provider failure message; the aborted reply has no message.

Both regressions check that triage stores the failure reason and no decision.
They also check that the lens runs at its default careful level and records why.
Removing the bridge's stop-reason guard makes both fail: the lens runs at quick instead.
The guard was restored after that check. Both tests then pass.

This closes a test gap without changing behaviour or a design decision.
