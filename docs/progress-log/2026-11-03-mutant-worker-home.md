# Mutation worker scratch HOME

The enumeration worker now receives `HOME` pointing at its owned scratch directory, beside `PATH` and `LANG`.
This follows the child-environment contract in AGENTS.md, learning 261.
The native replica observed no homedir lookup; this corrects a contract failure, not a reproduced runtime exploit.

For [pull request #250](https://github.com/melian-agent/melian/pull/250) and [issue #239](https://github.com/melian-agent/melian/issues/239),
the exact environment regression first failed on the missing `HOME`, then passed after the change.
The real preload-marker control still proves that inherited preload flags cannot run repository code in the worker.
Evidence and individual mutation runs live under `tmp/pr250-approved-phase-b/`.
The coordinator's whole host gate remains pending.
