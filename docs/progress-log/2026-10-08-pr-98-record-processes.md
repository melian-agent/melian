# Clear recovered mutation process records

The fix pass for [pull request #98](https://github.com/melian-agent/melian/pull/98) clears MutationProcesses after successful recovery termination. Abort clears the record in its terminal commit. A failed termination retains the record for recovery.

The authority suite uses a fake process table throughout: its supervisor and root records are fake, so reading real ps output for them tests the host rather than the contract. All 18 tests pass. Removing the recovery clear fails the recovered-task authority test; removing the abort clear fails the crashed-task retirement test. Both assert an empty durable table and the recorded child pids terminated through the fake. No signal code was mutated. The full gate is deferred to the end of this pass.
