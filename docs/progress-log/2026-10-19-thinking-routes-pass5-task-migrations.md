# Thinking routes: call task migrations under test

[Pull request #157](https://github.com/melian-agent/melian/pull/157), pass 5, addresses round 1 findings `72f28671` and `c590327f`.
Direct tests call SummaryTask and VerificationTask migrations with version-1 inputs and initial checkpoints captured by production code at `5175c664`.
They assert that both input and checkpoint survive unchanged.
The existing SQLite reopen tests still cover durable reservation and resumption.

The installed instrumenter enumerated four mutants on the reported spans: each migration returning undefined, and each returning an empty object.
Each exact replacement fails its task’s direct equality assertion. None is equivalent.
All mutations were restored, and both direct tests and the existing reopen tests pass.
Vitest’s related selection includes the direct file for both production sources.
The pass report under `tmp/m2/scratch-thinking/` holds the enumeration, failing outputs and full gate result.
No production behaviour changes. The implementation plan’s status stays unchanged.
