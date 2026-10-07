# Guard escalation instruction identity

[Pull request #85](https://github.com/melian-agent/melian/pull/85), ninth-round finding 85c3d2efd394c04c.

Existing tests accepted any 64-digit escalation fingerprint. None repeated a quick review after changing only the careful budget.

The new test escalates quick to careful and confirms an unchanged review attaches. It changes careful's findings budget without changing the lens version or quick settings. The review must replace its task and send the new budget to the careful model. The quick selection prefix stays unchanged.

Replacing the escalation fingerprint with 64 zeroes fails the task replacement assertion. Restoring the source passes the regression. Production behaviour and design decisions stay unchanged.
