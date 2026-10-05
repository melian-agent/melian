# Fallback answer capacity

[Pull request #62](https://github.com/melian-agent/melian/pull/62) raises the fallback's answer-array cap from 64 to 1024.
Folder variants can give triage more than 64 questions. The old schema refused a complete answer to such a request.

A regression asks 65 questions in one request and checks every recorded choice.
It fails with `invalidAnswer` under the old cap and passes under the new cap.
The decider still validates each answer against its tool schema.
This fixes the bound without changing a design decision.
