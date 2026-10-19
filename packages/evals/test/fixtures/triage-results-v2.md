# Version-2 triage measurement

`triage-results-v2.json` was written by the production `TriageResults` class at `42528319`, before adding thinking identity.
The writer parsed the main-written version-1 fixture and called `toJSON()`, preserving its choices and adding version 2's completion field.
The reopen test retains unset thinking through a format-3 write and a second parse.
It also proves that unset compares with an older unset record and refuses an explicit off record.
