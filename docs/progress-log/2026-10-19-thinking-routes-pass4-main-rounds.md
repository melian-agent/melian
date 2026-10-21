# Thinking routes: merge stored rounds

[Pull request #157](https://github.com/melian-agent/melian/pull/157) merges main at `077c6cb1`, including [pull request #152](https://github.com/melian-agent/melian/pull/152).
The telemetry reopen test keeps adjudication version 5 and publication version 6.
Its other assertions and both sides’ test cases survive.
The future-verdict refusal test now supplies version 13, above this branch’s supported version 12.

A new test reviews one revision at high, high, low, low reasoning.
It asserts two rounds and the same adjudication task for repeats at each fixed level.
The verifier and triage identity tests also assert round creation and attachment.
The verifier test checks that the first round stays frozen and its finder stays cached.
All three paths work without another production change or stored-version bump.
Existing fixtures from the earlier definitions cover reopen after the merge.

Five hand mutations remove lens, verifier and triage reasoning identity, disable adjudication attachment, or stop the round counter advancing.
Each fails its focused test; all mutations were restored.
The merge adds no production guard, branch, bound or early return beyond main’s existing work.
The implementation plan’s status stays unchanged.
