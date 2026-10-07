# Pull request 89, round twenty-nine fixes

Two fixes. Commit 35364683 stores each caller record against the lens task that produced it, so an overlapping rerun that replaces the task no longer inherits the old task's coverage and notes. The index commit writes only for the entry's current task, and a record naming another task is ignored on read. Commit 59a63c06 adds two CLI cases that prove the tier filter narrows caller queries to the files the tier's lenses select, and to none when the tier names no lens.
