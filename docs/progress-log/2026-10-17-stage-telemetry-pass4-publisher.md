# Preserve publication identity across the timing migration

[Pull request #135](https://github.com/melian-agent/melian/pull/135), pass 4.

The version-3 publication migration applied the version-1 input conversion to version 2. It erased attribution and changed untrusted writers to trusted writers. The migration now converts version 1 only and preserves version-2 input.

A new fixture records an untrusted version-2 task through main's publisher at `ddf7c113`. Four SQLite reopen cases change current trust, login, publisher permission or author permission. All four failed before the fix. All eight reopen tests pass after it. The tests require the correct supersession reason, unchanged task input and no provider calls.

The other timing version bumps preserve their inputs. Check, decision and adjudication migrations only add the legacy timing marker. No matching conversion error was found.
