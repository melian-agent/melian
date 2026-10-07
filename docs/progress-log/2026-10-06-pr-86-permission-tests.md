# Permission changes after a publication crash

[Pull request #86](https://github.com/melian-agent/melian/pull/86), Melian second-round finding 70be974565411290, lacked permission-only resume coverage. Two SQLite crash cases keep login and writer trust unchanged. One changes publisher permission; the other changes author permission. Each requires the interrupted task to be superseded for that field before posting one review and one ledger.

Restricting the attribution comparison to login fails both new cases: neither task is superseded. Restoring all three fields passes all seven attribution crash cases. The required-status rehearsal and switch remain pending.
