# Refuse an unreadable policy blob identity

Local review of [pull request #142](https://github.com/melian-agent/melian/pull/142) found a second way to retain a dismissed notice.
A non-UTF-8 policy name is displayed as percent-encoded text.
Passing that text to Git finds no path, so two different blobs receive the same absent-blob trigger hash.

The probe constructs raw names through Git's tree commands, because the sandbox refuses those names on disk.
Before the fix, two changed blobs produce the same trigger hash.
The regression fails because the check resolves with findings instead of refusing the unreadable identity.
Its control keeps reviewing an ordinary policy file beside an unrelated non-UTF-8 name.

The check now refuses a policy notice whose path cannot round-trip through a string argument to Git.
It uses the diff's existing percentEncoded flag and records why the authority cannot run.
The design, core guideline and as-built decision state that refusal.
No schema changes and no new lookup mechanism were needed.

The regression and its control pass after the fix.
Hand mutations remove the refusal, remove the encoding test, and remove the path match; each fails the regression or its control.
The whole gate finishes with four unchanged ps-dependent failures, 4,501 passes and 53 skips.
Formatting, types, dependency checks and the audit threshold pass.
The local phase 2 report records both regression runs and every mutation log. The host gate and static.mutation remain with the coordinator.
