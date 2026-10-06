# Denied scratch probes

Confirmed sixth-round finding 9a6413bfb3eb1194 for [pull request #89](https://github.com/melian-agent/melian/pull/89).
Unconditional deletion after a failed liveness probe leaves both existing scratch tests passing.
An EPERM fixture now proves that process-owned fetch, graph and coverage scratch retain their contents after cache open.

Removing the ESRCH guard fails the new regression by deleting the fetch directory.
The restored scratch suite passes three tests, including the existing dead-owner deletion case.
