# Recorded replies still owe thread resolution

[Pull request #73](https://github.com/melian-agent/melian/pull/73), round ten, item 1: confirmed. A recorded reply skipped recovery, though the old publisher never resolved its thread.

Publication now records thread resolution apart from the reply. A recorded addressed reply without that checkpoint resolves its thread without another reply or original-comment edit. The recovery also covers records at earlier heads. New resolutions record the reply and thread checkpoint together.

Validation: version 2 and version 5 records reopen through SQLite, at the current head and an earlier head. Publication resolves the thread, preserves the reply ID and records the checkpoint. A second publication performs no writes. Both regressions failed before the fix.
